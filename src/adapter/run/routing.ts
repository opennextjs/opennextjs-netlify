import process from 'node:process'

import type { Context } from '@netlify/edge-functions'

import type { NetlifyAdapterContext } from '../build/types.js'

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
}

type Match = {
  /** Regex */
  path: string

  /** additional conditions */
  has?: {
    type: 'header'
    key: string
    value?: string
  }[]
}

type CommonApply = {
  /** Headers to include in the response */
  headers?: Record<string, string>
}

export type RoutingRuleApply = RoutingRuleBase & {
  match: Match
  apply: CommonApply & {
    type: 'apply'
  }
}

export type RoutingRuleRedirect = RoutingRuleBase & {
  match: Match
  apply: CommonApply & {
    type: 'redirect'
    /** Can use capture groups from match.path */
    destination: string
    /** Allowed redirect status code, defaults to 307 if not defined */
    statusCode?: 301 | 302 | 307 | 308
  }
}

export type RoutingRuleRewrite = RoutingRuleBase & {
  match: Match
  apply: CommonApply & {
    type: 'rewrite'
    /** Can use capture groups from match.path */
    destination: string
    /** Forced status code for response, if not defined rewrite response status code will be used */
    statusCode?: 200 | 404 | 500
    /** Phases to re-run after matching this rewrite */
    rerunRoutingPhases?: RoutingPhase[]
  }
}

export type RoutingRuleMatchPrimitive = RoutingRuleBase & {
  match: {
    type: 'static-asset-or-function' | 'middleware' | 'image-cdn'
  }
}

export type RoutingPhaseRule = RoutingRuleBase & {
  routingPhase: RoutingPhase
}

export type RoutingRule =
  | RoutingRuleApply
  | RoutingRuleRedirect
  | RoutingRuleRewrite
  | RoutingPhaseRule
  | RoutingRuleMatchPrimitive

function selectRoutingPhasesRules(routingRules: RoutingRule[], phases: RoutingPhase[]) {
  const selectedRules: RoutingRule[] = []
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

// eslint-disable-next-line max-params
async function match(
  request: Request,
  context: Context,
  /** Filtered rules to match in this call */
  routingRules: RoutingRule[],
  /** All rules */
  allRoutingRules: RoutingRule[],
  outputs: NetlifyAdapterContext['preparedOutputs'],
  prefix: string | undefined,
  initialResponse: MaybeResponse,
): Promise<{ maybeResponse: MaybeResponse; currentRequest: Request }> {
  let currentRequest = request
  let maybeResponse: MaybeResponse = initialResponse

  const currentURL = new URL(currentRequest.url)
  let { pathname } = currentURL

  for (const rule of routingRules) {
    if (prefix) {
      console.log(prefix, 'Evaluating rule:', rule.description ?? JSON.stringify(rule))
    }
    if ('match' in rule) {
      if ('type' in rule.match) {
        if (rule.match.type === 'static-asset-or-function') {
          let matchedType: 'static-asset' | 'function' | 'static-asset-alias' | null = null

          // below assumes no overlap between static assets (files and aliases) and functions so order of checks "doesn't matter"
          // unclear what should be precedence if there would ever be overlap
          if (outputs.staticAssets.includes(pathname)) {
            matchedType = 'static-asset'
          } else if (outputs.endpoints.includes(pathname)) {
            matchedType = 'function'
          } else {
            const staticAlias = outputs.staticAssetsAliases[pathname]
            if (staticAlias) {
              matchedType = 'static-asset-alias'
              currentRequest = new Request(new URL(staticAlias, currentRequest.url), currentRequest)
              pathname = staticAlias
            }
          }

          if (matchedType) {
            if (prefix) {
              console.log(
                prefix,
                `Matched static asset or function (${matchedType}): ${pathname} -> ${currentRequest.url}`,
              )
            }
            maybeResponse = {
              ...maybeResponse,
              response: await context.next(currentRequest),
            }
          }
        } else if (rule.match.type === 'image-cdn' && pathname.startsWith('/.netlify/image/')) {
          if (prefix) {
            console.log(prefix, 'Matched image cdn:', pathname)
          }

          maybeResponse = {
            ...maybeResponse,
            response: await context.next(currentRequest),
          }
        }
      } else if ('apply' in rule) {
        const sourceRegexp = new RegExp(rule.match.path)
        const sourceMatch = pathname.match(sourceRegexp)
        if (sourceMatch) {
          // check additional conditions
          if (rule.match.has) {
            let hasAllMatch = true
            for (const condition of rule.match.has) {
              if (condition.type === 'header') {
                if (typeof condition.value === 'undefined') {
                  if (!currentRequest.headers.has(condition.key)) {
                    hasAllMatch = false
                    break
                  }
                } else if (currentRequest.headers.get(condition.key) !== condition.value) {
                  hasAllMatch = false
                  break
                }
              }
            }

            if (!hasAllMatch) {
              continue
            }
          }

          const replacements: Record<string, string> = {}
          if (sourceMatch.groups) {
            for (const [key, value] of Object.entries(sourceMatch.groups)) {
              replacements[`$${key}`] = value
            }
          }
          for (const [index, element] of sourceMatch.entries()) {
            replacements[`$${index}`] = element ?? ''
          }

          if (prefix) {
            console.log(prefix, 'Matched rule', pathname, rule, sourceMatch, replacements)
          }

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

            // pathname.replace(sourceRegexp, rule.apply.destination)
            const destURL = new URL(replaced, currentURL)
            currentRequest = new Request(destURL, currentRequest)

            if (rule.apply.statusCode) {
              maybeResponse = {
                ...maybeResponse,
                status: rule.apply.statusCode,
              }
            }

            if (rule.apply.rerunRoutingPhases) {
              const { maybeResponse: updatedMaybeResponse } = await match(
                currentRequest,
                context,
                selectRoutingPhasesRules(routingRules, rule.apply.rerunRoutingPhases),
                allRoutingRules,
                outputs,
                prefix,
                maybeResponse,
              )
              maybeResponse = updatedMaybeResponse
            }
          } else if (rule.apply.type === 'redirect') {
            const replaced = pathname.replace(sourceRegexp, rule.apply.destination)
            if (prefix) {
              console.log(prefix, `Redirecting ${pathname} to ${replaced}`)
            }
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
    }

    if (maybeResponse?.response && !rule.continue) {
      // once hit a response short circuit
      return { maybeResponse, currentRequest }
    }
  }
  return { maybeResponse, currentRequest }
}

export async function runNextRouting(
  request: Request,
  context: Context,
  routingRules: RoutingRule[],
  outputs: NetlifyAdapterContext['preparedOutputs'],
) {
  if (request.headers.has('x-ntl-routing')) {
    // don't route multiple times for same request
    return
  }

  const prefix = request.url.includes('_next/static')
    ? undefined
    : `[${
        request.headers.get('x-nf-request-id') ??
        // for ntl serve, we use a combination of timestamp and pid to have a unique id per request as we don't have x-nf-request-id header then
        // eslint-disable-next-line no-plusplus
        `${Date.now()} - #${process.pid}:${++requestCounter}`
      }]`

  if (prefix) {
    console.log(prefix, 'Incoming request for routing:', request.url)
  }

  let currentRequest = new Request(request)
  currentRequest.headers.set('x-ntl-routing', '1')

  let { maybeResponse, currentRequest: updatedCurrentRequest } = await match(
    currentRequest,
    context,
    selectRoutingPhasesRules(routingRules, routingPhasesWithoutHitOrError),
    routingRules,
    outputs,
    prefix,
    {
      [NOT_A_FETCH_RESPONSE]: true,
    },
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

  if (maybeResponse.response && (maybeResponse.status ?? maybeResponse.response?.status !== 404)) {
    const initialResponse = maybeResponse.response
    const { maybeResponse: updatedMaybeResponse } = await match(
      currentRequest,
      context,
      selectRoutingPhasesRules(routingRules, ['hit']),
      routingRules,
      outputs,
      prefix,
      maybeResponse,
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
      prefix,
      { ...maybeResponse, status: 404 },
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

  // for debugging add log prefixes to response headers to make it easy to find logs for a given request
  if (prefix) {
    response.headers.set('x-ntl-log-prefix', prefix)
    console.log(prefix, 'Serving response', response.status)
  }

  return response
}
