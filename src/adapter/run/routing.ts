import process from 'node:process'
import { format } from 'node:util'

import type { Context } from '@netlify/edge-functions'
import { type Span, SpanStatusCode, trace } from '@opentelemetry/api'
import { SugaredTracer } from '@opentelemetry/api/experimental'

import type { NetlifyAdapterContext } from '../build/types.js'

import { determineFreshness } from './headers.js'
import { getIsrResponse } from './isr.js'

const routingPhases = ['entry', 'filesystem', 'rewrite', 'hit', 'error'] as const
const routingPhasesWithoutHitOrError = routingPhases.filter(
  (phase) => phase !== 'hit' && phase !== 'error',
)

export type RoutingPhase = (typeof routingPhases)[number]

type RoutingRuleBase = {
  /**
   * Human readable description of the rule (for debugging purposes only)
   */
  description: string
  /** if we should keep going even if we already have potential response */
  continue?: true
  /** this will allow to evaluate route even if previous route was matched and didn't have continue: true */
  override?: true
}

type Match = {
  /** Regex */
  path?: string

  /** additional conditions */
  has?: {
    type: 'header'
    key: string
    value?: string
  }[]

  /** Locale detection */
  // detectLocale?: { locales: string[]; localeCookie: string }
}

type CommonApply = {
  /** Headers to include in the response */
  headers?: Record<string, string>
}

export type RoutingRuleMatchPrimitive = RoutingRuleBase & {
  type: 'static-asset-or-function' | 'image-cdn'
}

export type RoutingPhaseRule = RoutingRuleBase & {
  routingPhase: RoutingPhase
}

export type RoutingRuleApply = RoutingRuleBase & {
  match?: Match
  apply:
    | (CommonApply & {
        type: 'apply'
      })
    | {
        type: 'middleware'
      }
    | (CommonApply & {
        type: 'rewrite'
        /** Can use capture groups from match.path */
        destination: string
        /** Forced status code for response, if not defined rewrite response status code will be used */
        statusCode?: 200 | 404 | 500
        /** Phases to re-run after matching this rewrite */
        rerunRoutingPhases?: RoutingPhase[]
      })
    | (CommonApply & {
        type: 'redirect'
        /** Can use capture groups from match.path */
        destination: string
        /** Allowed redirect status code, defaults to 307 if not defined */
        statusCode?: 301 | 302 | 307 | 308
      })
}

export type RoutingRule = RoutingRuleApply | RoutingPhaseRule | RoutingRuleMatchPrimitive

export type RoutingRuleWithoutPhase = Exclude<RoutingRule, RoutingPhaseRule>

function selectRoutingPhasesRules(routingRules: RoutingRule[], phases: RoutingPhase[]) {
  const selectedRules: RoutingRuleWithoutPhase[] = []
  let currentPhase: RoutingPhase | undefined
  for (const rule of routingRules) {
    if ('routingPhase' in rule) {
      currentPhase = rule.routingPhase
    } else if (currentPhase && phases.includes(currentPhase)) {
      selectedRules.push(rule)
    }
  }

  return selectedRules
}

let requestCounter = 0

// this is so typescript doesn't think this is fetch response object and rather a builder for a final response
const NOT_A_FETCH_RESPONSE = Symbol('Not a Fetch Response')
type MaybeResponse = {
  response?: Response | undefined
  status?: number | undefined
  headers?: HeadersInit | undefined
  [NOT_A_FETCH_RESPONSE]: true
}

function replaceGroupReferences(input: string, replacements: Record<string, string>) {
  let output = input
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(key, value)
  }
  return output
}

function relativizeURL(url: string | URL, base: string | URL) {
  const baseURL = typeof base === 'string' ? new URL(base) : base
  const relative = new URL(url, base)
  const origin = `${baseURL.protocol}//${baseURL.host}`
  return `${relative.protocol}//${relative.host}` === origin
    ? relative.toString().replace(origin, '')
    : relative.toString()
}

// eslint-disable-next-line max-params
async function match(
  request: Request,
  context: Context,
  /** Filtered rules to match in this call */
  routingRules: RoutingRuleWithoutPhase[],
  /** All rules */
  allRoutingRules: RoutingRule[],
  outputs: NetlifyAdapterContext['preparedOutputs'],
  log: (fmt: string, ...args: unknown[]) => void,
  initialResponse: MaybeResponse,
  asyncLoadMiddleware: () => Promise<(req: Request) => Promise<Response>>,
  tracer: SugaredTracer,
  spanName: string,
): Promise<{ maybeResponse: MaybeResponse; currentRequest: Request }> {
  let currentRequest = request
  let maybeResponse: MaybeResponse = initialResponse

  let onlyOverrides = false

  return tracer.withActiveSpan(spanName, async () => {
    for (const rule of routingRules) {
      const currentURL = new URL(currentRequest.url)
      const { pathname } = currentURL

      const desc = rule.description ?? JSON.stringify(rule)

      if (onlyOverrides && !rule.override) {
        log('Skipping rule because there is a match and this is not override:', desc, pathname)
        continue
      }

      // eslint-disable-next-line no-loop-func
      await tracer.withActiveSpan(desc, async (span) => {
        log('Evaluating rule:', desc, pathname)

        let matched = false
        let shouldContinueOnMatch = rule.continue ?? false

        if ('type' in rule) {
          if (rule.type === 'static-asset-or-function') {
            let matchedType: 'static-asset' | 'static-asset-alias' | 'function' | 'isr' | null =
              null

            // below assumes no overlap between static assets (files and aliases) and functions so order of checks "doesn't matter"
            // unclear what should be precedence if there would ever be overlap
            if (outputs.staticAssets.includes(pathname)) {
              matchedType = 'static-asset'
            } else if (pathname in outputs.staticAssetsAliases) {
              const staticAlias = outputs.staticAssetsAliases[pathname]
              if (staticAlias) {
                matchedType = 'static-asset-alias'
                currentRequest = new Request(
                  new URL(staticAlias, currentRequest.url),
                  currentRequest,
                )
              }
            } else if (pathname.toLowerCase() in outputs.endpoints) {
              const endpoint = outputs.endpoints[pathname.toLowerCase()]

              matchedType = endpoint.type
            }

            if (matchedType) {
              log(
                `Matched static asset or function (${matchedType}): ${pathname} -> ${currentRequest.url}`,
              )

              let handled = false
              if (matchedType === 'isr') {
                const start = Date.now()
                const isrResult = await getIsrResponse(currentRequest, outputs)
                if (isrResult) {
                  const isrSource = isrResult.response.headers.get('x-isr-source')
                  const isrFreshness = determineFreshness(isrResult.response.headers)
                  isrResult.response.headers.set('x-isr-freshness', isrFreshness)
                  log(
                    `Serving ISR response for: ${pathname} -> ${currentRequest.url} from ${isrSource} (${isrFreshness})`,
                  )

                  if (isrResult.postponedState && isrResult.response.body) {
                    log('there is PPR here')
                    const resumeRequest = new Request(currentRequest, {
                      ...currentRequest,
                      headers: {
                        ...currentRequest.headers,
                        'x-ppr-resume': isrResult.postponedState,
                      },
                    })

                    const resumeResponsePromise = context.next(resumeRequest)

                    const mergedBody = new ReadableStream({
                      async start(controller) {
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        const shellReader = isrResult.response.body!.getReader()
                        while (true) {
                          const { done, value } = await shellReader.read()
                          if (done) {
                            break
                          }
                          controller.enqueue(value)
                        }
                        controller.enqueue(
                          new TextEncoder().encode(
                            `\n<!-- POSTPONED INCOMING!! ${Date.now() - start}ms -->\n`,
                          ),
                        )
                        const resumeResponse = await resumeResponsePromise
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        const resumeReader = resumeResponse.body!.getReader()
                        while (true) {
                          const { done, value } = await resumeReader.read()
                          if (done) {
                            break
                          }
                          controller.enqueue(value)
                        }
                        controller.enqueue(
                          new TextEncoder().encode(
                            `\n<!-- POSTPONED Attached!! ${Date.now() - start}ms -->\n`,
                          ),
                        )
                        controller.close()
                      },
                    })

                    maybeResponse = {
                      ...maybeResponse,
                      response: new Response(mergedBody, {
                        ...isrResult.response,
                        headers: {
                          ...isrResult.response.headers,
                          'x-ppr-merged': '1',
                        },
                      }),
                    }
                  } else {
                    maybeResponse = {
                      ...maybeResponse,
                      response: isrResult.response,
                    }
                  }
                  handled = true
                }
              }

              if (!handled) {
                maybeResponse = {
                  ...maybeResponse,
                  response: await context.next(currentRequest),
                }
              }
              matched = true
            }
          } else if (rule.type === 'image-cdn' && pathname.startsWith('/.netlify/image/')) {
            log('Matched image cdn:', pathname)

            maybeResponse = {
              ...maybeResponse,
              response: await context.next(currentRequest),
            }
            matched = true
          }
        } else {
          const replacements: Record<string, string> = {}

          if (rule.match?.path) {
            const sourceRegexp = new RegExp(rule.match.path)
            const sourceMatch = pathname.match(sourceRegexp)
            if (sourceMatch) {
              if (sourceMatch.groups) {
                for (const [key, value] of Object.entries(sourceMatch.groups)) {
                  replacements[`$${key}`] = value
                }
              }
              for (const [index, element] of sourceMatch.entries()) {
                replacements[`$${index}`] = element ?? ''
              }
            } else {
              span.setStatus({ code: SpanStatusCode.ERROR, message: 'Miss' })
              // log('Path did not match regex', rule.match.path, pathname)
              return
            }
          }

          if (rule.match?.has) {
            let hasAllMatch = true
            for (const condition of rule.match.has) {
              if (condition.type === 'header') {
                if (typeof condition.value === 'undefined') {
                  if (!currentRequest.headers.has(condition.key)) {
                    hasAllMatch = false
                    // log('request header does not exist', {
                    //   key: condition.key,
                    // })
                    break
                  }
                } else if (currentRequest.headers.get(condition.key) !== condition.value) {
                  hasAllMatch = false
                  // log('request header not the same', {
                  //   key: condition.key,
                  //   match: condition.value,
                  //   actual: currentRequest.headers.get(condition.key),
                  // })
                  break
                }
              }
            }

            if (!hasAllMatch) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: 'Miss' })
              return
            }
          }

          matched = true

          log('Matched rule', pathname, rule, replacements)

          if (rule.apply.type === 'middleware') {
            if (outputs.middleware) {
              const runMiddleware = await asyncLoadMiddleware()

              const middlewareResponse = await runMiddleware(currentRequest)

              // we do get response, but sometimes response might want to rewrite, so we need to process that response and convert to routing setup

              // const rewrite = middlewareResponse.headers.get('x-middleware-rewrite')
              const redirect = middlewareResponse.headers.get('location')
              const nextRedirect = middlewareResponse.headers.get('x-nextjs-redirect')
              const isNext = middlewareResponse.headers.get('x-middleware-next')

              const requestHeaders = new Headers(currentRequest.headers)

              const overriddenHeaders = middlewareResponse.headers.get(
                'x-middleware-override-headers',
              )
              if (overriddenHeaders) {
                const headersToUpdate = new Set(
                  overriddenHeaders.split(',').map((header) => header.trim()),
                )
                middlewareResponse.headers.delete('x-middleware-override-headers')

                // Delete headers.
                // eslint-disable-next-line unicorn/no-useless-spread
                for (const key of [...requestHeaders.keys()]) {
                  if (!headersToUpdate.has(key)) {
                    requestHeaders.delete(key)
                  }
                }

                // Update or add headers.
                for (const header of headersToUpdate) {
                  const oldHeaderKey = `x-middleware-request-${header}`
                  const headerValue = middlewareResponse.headers.get(oldHeaderKey) || ''

                  const oldValue = requestHeaders.get(header) || ''

                  if (oldValue !== headerValue) {
                    if (headerValue) {
                      requestHeaders.set(header, headerValue)
                    } else {
                      requestHeaders.delete(header)
                    }
                  }
                  middlewareResponse.headers.delete(oldHeaderKey)
                }
              }

              if (
                !middlewareResponse.headers.has('x-middleware-rewrite') &&
                !middlewareResponse.headers.has('x-middleware-next') &&
                !middlewareResponse.headers.has('location')
              ) {
                middlewareResponse.headers.set('x-middleware-refresh', '1')
              }
              middlewareResponse.headers.delete('x-middleware-next')

              for (const [key, value] of middlewareResponse.headers.entries()) {
                if (
                  [
                    'content-length',
                    'x-middleware-rewrite',
                    'x-middleware-redirect',
                    'x-middleware-refresh',
                    'accept-encoding',
                    'keepalive',
                    'keep-alive',
                    'content-encoding',
                    'transfer-encoding',
                    // https://github.com/nodejs/undici/issues/1470
                    'connection',
                    // marked as unsupported by undici: https://github.com/nodejs/undici/blob/c83b084879fa0bb8e0469d31ec61428ac68160d5/lib/core/request.js#L354
                    'expect',
                  ].includes(key)
                ) {
                  continue
                }

                // for set-cookie, the header shouldn't be added to the response
                // as it's only needed for the request to the middleware function.
                if (key === 'x-middleware-set-cookie') {
                  requestHeaders.set(key, value)
                  continue
                }

                if (key === 'location') {
                  maybeResponse = {
                    ...maybeResponse,
                    headers: {
                      ...maybeResponse.headers,
                      [key]: relativizeURL(value, currentRequest.url),
                    },
                  }
                  // relativizeURL(value, currentRequest.url)
                }

                if (value) {
                  requestHeaders.set(key, value)

                  maybeResponse = {
                    ...maybeResponse,
                    headers: {
                      ...maybeResponse.headers,
                      [key]: value,
                    },
                  }
                }
              }

              currentRequest = new Request(currentRequest.url, {
                ...currentRequest,
                headers: requestHeaders,
              })

              const rewrite = middlewareResponse.headers.get('x-middleware-rewrite')
              console.log('Middleware response', {
                status: middlewareResponse.status,
                rewrite,
                redirect,
                nextRedirect,
                overriddenHeaders,
                isNext,
                // requestHeaders,
              })

              if (rewrite) {
                log('Middleware rewrite to', rewrite)
                const rewriteUrl = new URL(rewrite, currentRequest.url)
                const baseUrl = new URL(currentRequest.url)
                if (rewriteUrl.toString() === baseUrl.toString()) {
                  log('Rewrite url is same as original url')
                }
                currentRequest = new Request(
                  new URL(rewriteUrl, currentRequest.url),
                  currentRequest,
                )
                shouldContinueOnMatch = true
              } else if (nextRedirect) {
                shouldContinueOnMatch = true
                // just continue
                // } else if (redirect) {
                //   relativizeURL(redirect, currentRequest.url)
              } else if (isNext) {
                // just continue
                shouldContinueOnMatch = true
              } else {
                // this includes redirect case
                maybeResponse = {
                  ...maybeResponse,
                  response: middlewareResponse,
                }
              }
            }
          } else {
            if (rule.apply.headers) {
              maybeResponse = {
                ...maybeResponse,
                headers: {
                  ...maybeResponse.headers,
                  ...Object.fromEntries(
                    Object.entries(rule.apply.headers).map(([key, value]) => {
                      return [key, replaceGroupReferences(value, replacements)]
                    }),
                  ),
                },
              }
            }

            if (rule.apply.type === 'rewrite') {
              const replaced = replaceGroupReferences(rule.apply.destination, replacements)

              const destURL = new URL(replaced, currentURL)
              currentRequest = new Request(destURL, currentRequest)

              if (rule.apply.statusCode) {
                maybeResponse = {
                  ...maybeResponse,
                  status: rule.apply.statusCode,
                }
              }

              if (rule.apply.rerunRoutingPhases) {
                log('Re-running routing phases:', rule.apply.rerunRoutingPhases.join(', '))
                const { maybeResponse: updatedMaybeResponse } = await match(
                  currentRequest,
                  context,
                  selectRoutingPhasesRules(allRoutingRules, rule.apply.rerunRoutingPhases),
                  allRoutingRules,
                  outputs,
                  log,
                  maybeResponse,
                  asyncLoadMiddleware,
                  tracer,
                  `Running phases: ${rule.apply.rerunRoutingPhases.join(', ')}`,
                )
                maybeResponse = updatedMaybeResponse
              }
            } else if (rule.apply.type === 'redirect') {
              const replaced = replaceGroupReferences(rule.apply.destination, replacements)

              log(`Redirecting ${pathname} to ${replaced}`)

              const status = rule.apply.statusCode ?? 307
              maybeResponse = {
                ...maybeResponse,
                status,
                response: new Response(null, {
                  status,
                  headers: {
                    Location: replaced,
                  },
                }),
              }
            }
          }
        }

        if (matched && !shouldContinueOnMatch) {
          onlyOverrides = true
          // once hit a match short circuit, unless we should continue
          // return { maybeResponse, currentRequest }
        }

        if (!matched) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'Miss' })
        }
      })
    }
    return { maybeResponse, currentRequest }
  })
}

// eslint-disable-next-line max-params
export async function runNextRouting(
  request: Request,
  context: Context,
  routingRules: RoutingRule[],
  outputs: NetlifyAdapterContext['preparedOutputs'],
  asyncLoadMiddleware: () => Promise<(req: Request) => Promise<Response>>,
) {
  if (request.headers.has('x-ntl-routing')) {
    // don't route multiple times for same request
    return
  }

  const tracer = new SugaredTracer(trace.getTracer('next-routing', '0.0.1'))
  const { pathname } = new URL(request.url)

  return tracer.withActiveSpan(`next_routing ${request.method} ${pathname}`, async () => {
    const stdoutPrefix = request.url.includes('.well-known')
      ? undefined
      : `[${
          request.headers.get('x-nf-request-id') ??
          // for ntl serve, we use a combination of timestamp and pid to have a unique id per request as we don't have x-nf-request-id header then
          // eslint-disable-next-line no-plusplus
          `${Date.now()} - #${process.pid}:${++requestCounter}`
        }]`

    const spanCounter = new WeakMap<Span, number>()
    const log = (fmt: string, ...args: unknown[]) => {
      const formatted = format(fmt, ...args)
      if (stdoutPrefix) {
        console.log(stdoutPrefix, formatted)
      }

      const currentSpan = trace.getActiveSpan()
      if (currentSpan) {
        const currentSpanCounter = (spanCounter.get(currentSpan) ?? 0) + 1
        spanCounter.set(currentSpan, currentSpanCounter)
        currentSpan.setAttribute(`log.${String(currentSpanCounter).padStart(3, ' ')}`, formatted)
      }
    }

    log('Incoming request for routing:', request.method, request.url)

    let currentRequest = new Request(request)
    currentRequest.headers.set('x-ntl-routing', '1')

    let { maybeResponse, currentRequest: updatedCurrentRequest } = await match(
      currentRequest,
      context,
      selectRoutingPhasesRules(routingRules, routingPhasesWithoutHitOrError),
      routingRules,
      outputs,
      log,
      {
        [NOT_A_FETCH_RESPONSE]: true,
      },
      asyncLoadMiddleware,
      tracer,
      'Routing Phases Before Hit/Error',
    )
    currentRequest = updatedCurrentRequest

    if (!maybeResponse.response) {
      // check other things
      maybeResponse = {
        ...maybeResponse,
        response: await context.next(currentRequest),
      }
    }

    let response: Response

    if (
      maybeResponse.response &&
      (maybeResponse.status ?? maybeResponse.response?.status !== 404)
    ) {
      const initialResponse = maybeResponse.response
      const { maybeResponse: updatedMaybeResponse } = await match(
        currentRequest,
        context,
        selectRoutingPhasesRules(routingRules, ['hit']),
        routingRules,
        outputs,
        log,
        maybeResponse,
        asyncLoadMiddleware,
        tracer,
        'Hit Routing Phase',
      )
      maybeResponse = updatedMaybeResponse

      const finalResponse = maybeResponse.response ?? initialResponse

      response = new Response(finalResponse.body, {
        ...finalResponse,
        headers: {
          ...Object.fromEntries(finalResponse.headers.entries()),
          ...maybeResponse.headers,
        },
        status: maybeResponse.status ?? finalResponse.status ?? 200,
      })
    } else {
      const { maybeResponse: updatedMaybeResponse } = await match(
        currentRequest,
        context,
        selectRoutingPhasesRules(routingRules, ['error']),
        routingRules,
        outputs,
        log,
        { ...maybeResponse, status: 404 },
        asyncLoadMiddleware,
        tracer,
        'Error Routing Phase',
      )
      maybeResponse = updatedMaybeResponse

      const finalResponse = maybeResponse.response ?? new Response('Not Found', { status: 404 })

      response = new Response(finalResponse.body, {
        ...finalResponse,
        headers: {
          ...Object.fromEntries(finalResponse.headers.entries()),
          ...maybeResponse.headers,
        },
        status: maybeResponse.status ?? finalResponse.status ?? 200,
      })
    }

    {
      // this is just for backward compat for tests - it should not have impact on anything because this edge function is not cacheable
      const adapterCdnCacheControl = response.headers.get('adapter-cdn-cache-control')
      if (adapterCdnCacheControl) {
        // TODO: if stale
        response.headers.set('netlify-cdn-cache-control', adapterCdnCacheControl)
        response.headers.delete('adapter-cdn-cache-control')
      }
    }

    log('Serving response', response.status)

    // for debugging add log prefixes to response headers to make it easy to find logs for a given request
    // if (prefix) {
    //   response.headers.set('x-ntl-log-prefix', prefix)
    //   console.log(prefix, 'Serving response', response.status)
    // }

    return response
  })
}
