import type { Context } from '@netlify/edge-functions'

import { resolveRoutes } from '../vendor/@next/routing/dist/index.js'
import type { ResolveRoutesParams } from '../vendor/@next/routing/dist/types.js'

export type RoutingPreparedConfig = Omit<ResolveRoutesParams, 'url' | 'requestBody' | 'headers'>

export async function runNextRouting(
  request: Request,
  context: Context,
  routingBuildTimeConfig: RoutingPreparedConfig,
) {
  const routingConfig = {
    ...routingBuildTimeConfig,

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    invokeMiddleware: (ctx) => {
      // no-op for now
      return Promise.resolve({})
    },

    url: new URL(request.url),

    // routing util types expect body to always be there
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    requestBody: request.body!,
    headers: request.headers,
  } satisfies ResolveRoutesParams

  const result = await resolveRoutes(routingConfig)

  if (result.logs) {
    console.log('Routing logs:\n', result.logs)
  }

  if (result.redirect) {
    return Response.redirect(result.redirect.url, result.redirect.status)
  }

  if (result.matchedPathname) {
    const newUrl = new URL(result.matchedPathname, request.url)
    if (result.routeMatches) {
      for (const [key, value] of Object.entries(result.routeMatches)) {
        newUrl.searchParams.set(key, value)
      }
    }
    const adjustedRequest = new Request(newUrl, request)
    return context.next(adjustedRequest)
  }

  return Response.json(result)
}
