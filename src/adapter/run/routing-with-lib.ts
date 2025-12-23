import { format } from 'node:util'

import type { Context } from '@netlify/edge-functions'

import type { NetlifyAdapterContext } from '../build/types.js'
import { resolveRoutes } from '../vendor/@next/routing/dist/index.js'
import type { ResolveRoutesParams } from '../vendor/@next/routing/dist/types.js'

import { determineFreshness } from './headers.js'
import { getIsrResponse } from './isr.js'

export type RoutingPreparedConfig = Omit<ResolveRoutesParams, 'url' | 'requestBody' | 'headers'>

export async function runNextRouting(
  request: Request,
  context: Context,
  routingBuildTimeConfig: RoutingPreparedConfig,
  preparedOutputs: NetlifyAdapterContext['preparedOutputs'],
) {
  const url = new URL(request.url)

  const routingConfig = {
    ...routingBuildTimeConfig,

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    invokeMiddleware: (ctx) => {
      // no-op for now
      return Promise.resolve({})
    },

    url,
    // routing util types expect body to always be there
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    requestBody: request.body!,
    headers: request.headers,
  } satisfies ResolveRoutesParams

  let { logs, ...result } = await resolveRoutes(routingConfig)

  let response: Response | undefined

  function debugLog(...args: unknown[]) {
    logs += `${format(...args)}\n\n`
  }

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
      response = await context.next(adjustedRequest)
    }
  }

  if (!response && result.redirect) {
    response = Response.redirect(result.redirect.url, result.redirect.status)
  }

  if (response) {
    if (result.resolvedHeaders) {
      for (const [key, value] of Object.entries(result.resolvedHeaders)) {
        // TODO: why are those here?
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
  } else {
    response = Response.json({ info: 'NOT YET HANDLED RESULT TYPE', ...result })
  }

  if (url.searchParams.has('debug_routing') || request.headers.has('x-debug-routing')) {
    return Response.json({ ...result, response, logs })
  }

  if (logs) {
    console.log('Routing logs:\n', logs)
  }

  return response
}
