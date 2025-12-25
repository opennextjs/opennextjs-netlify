import type { Context } from '@netlify/edge-functions'

import type { NetlifyAdapterContext } from '../build/types.js'
import {
  debugLog,
  RequestTracker,
  RequestTrackerAsyncLocalStorage,
  resolveRoutes,
  responseToMiddlewareResult,
} from '../vendor/@next/routing/dist/index.js'
import type { ResolveRoutesParams } from '../vendor/@next/routing/dist/types.d.ts'

import { determineFreshness } from './headers.js'
import { getIsrResponse } from './isr.js'

export type RoutingPreparedConfig = Omit<ResolveRoutesParams, 'url' | 'requestBody' | 'headers'>

let middlewareHandler: ((req: Request) => Promise<Response>) | undefined

// eslint-disable-next-line max-params
export async function runNextRouting(
  request: Request,
  context: Context,
  routingBuildTimeConfig: RoutingPreparedConfig,
  preparedOutputs: NetlifyAdapterContext['preparedOutputs'],
  middlewareConfig:
    | { enabled: false }
    | {
        enabled: true
        matchers: RegExp[]
        load: () => Promise<(req: Request) => Promise<Response>>
      },
) {
  const requestTracker: RequestTracker = {
    logs: '',
  }
  return await RequestTrackerAsyncLocalStorage.run(requestTracker, async () => {
    const url = new URL(request.url)

    let response: Response | undefined

    const routingConfig: ResolveRoutesParams = {
      ...routingBuildTimeConfig,

      invokeMiddleware: async (ctx): ReturnType<ResolveRoutesParams['invokeMiddleware']> => {
        if (!middlewareConfig.enabled) {
          debugLog('Middleware not enabled')
          return {}
        }

        let matched = false
        for (const matcher of middlewareConfig.matchers) {
          if (matcher.test(ctx.url.pathname)) {
            matched = true
            break
          }
        }

        debugLog('Middleware matching', {
          matched,
          pathname: ctx.url.pathname,
          matchers: middlewareConfig.matchers,
        })

        if (!matched) {
          return {}
        }

        if (!middlewareHandler) {
          middlewareHandler = await middlewareConfig.load()
        }

        const middlewareRequest = new Request(ctx.url, {
          headers: ctx.headers,
          // method: ctx.method,
          body: ctx.requestBody,
        })

        const middlewareResponse = await middlewareHandler(middlewareRequest)

        const middlewareResult = responseToMiddlewareResult(
          middlewareResponse,
          ctx.headers,
          ctx.url,
        )

        if (middlewareResult.bodySent) {
          response = middlewareResponse
        }

        return middlewareResult
      },

      url,
      // routing util types expect body to always be there
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      requestBody: request.body!,
      headers: request.headers,
    } satisfies ResolveRoutesParams

    const result = await resolveRoutes(routingConfig)

    debugLog('Routing result', { result })

    if (result.matchedPathname) {
      const newUrl = new URL(result.matchedPathname, request.url)
      if (result.routeMatches) {
        for (const [key, value] of Object.entries(result.routeMatches)) {
          newUrl.searchParams.set(key, value)
        }
      }
      const adjustedRequest = new Request(newUrl, request)

      const matchedEndpoint = preparedOutputs.endpoints[result.matchedPathname]

      if (matchedEndpoint?.type === 'isr') {
        debugLog('matched ISR', { matchedEndpoint })
        const isrResult = await getIsrResponse(adjustedRequest, preparedOutputs)
        if (isrResult) {
          const isrSource = isrResult.response.headers.get('x-isr-source')
          const isrFreshness = determineFreshness(isrResult.response.headers)
          isrResult.response.headers.set('x-isr-freshness', isrFreshness)

          debugLog('Serving ISR response', { adjustedRequest, isrSource, isrFreshness })

          if (isrResult.postponedState && isrResult.response.body) {
            const pprStartTimestamp = Date.now()
            debugLog('there is PPR here')
            const resumeRequest = new Request(adjustedRequest, {
              ...adjustedRequest,
              headers: {
                ...adjustedRequest.headers,
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
                    `\n<!-- POSTPONED INCOMING!! ${Date.now() - pprStartTimestamp}ms -->\n`,
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
                    `\n<!-- POSTPONED Attached!! ${Date.now() - pprStartTimestamp}ms -->\n`,
                  ),
                )
                controller.close()
              },
            })
            response = new Response(mergedBody, {
              ...isrResult.response,
              headers: {
                ...isrResult.response.headers,
                'x-ppr-merged': '1',
              },
            })
          } else {
            // eslint-disable-next-line prefer-destructuring
            response = isrResult.response
          }
        }
      }

      if (!response) {
        debugLog('invoking output', { pathname: result.matchedPathname, adjustedRequest })
        response = await context.next(adjustedRequest)
      }
    }

    if (!response && result.redirect) {
      debugLog('preparing redirect')
      response = new Response(null, {
        status: result.redirect.status,
        headers: { location: result.redirect.url.toString() },
      })
    }

    if (response && result.resolvedHeaders) {
      debugLog('Applying response headers')
      for (const [key, value] of result.resolvedHeaders.entries()) {
        // TODO: why are those here? those are request headers, but they are mixed with response headers
        if (
          [
            'accept',
            'connection',
            'host',
            'user-agent',
            'x-forwarded-for',
            'x-nf-blobs-info',
            'x-nf-deploy-context',
            'x-nf-deploy-id',
            'x-nf-request-id',
          ].includes(key.toLowerCase())
        ) {
          continue
        }
        response.headers.set(key, value)
      }
    }

    if (!response && !result.status) {
      // no match found, we just let thing through as there might be non-Next.js route to handle
      debugLog('No next.js route matched, doing pass-through for any non-nextjs route handling', {
        result,
      })
    }

    if (url.searchParams.has('debug_routing') || request.headers.has('x-debug-routing')) {
      return Response.json({ ...result, response, logs: requestTracker.logs })
    }

    if (requestTracker.logs) {
      console.log('Routing logs:\n', requestTracker.logs)
    }

    return response
  })
}
