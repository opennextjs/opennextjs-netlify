import type { ResolveRoutesResult } from '@next/routing'

export { resolveRoutes, responseToMiddlewareResult } from '@next/routing'
export type { ResolveRoutesParams, ResolveRoutesResult } from '@next/routing'

// Next's router-server drops these from every incoming request before doing anything with it
// (`filterInternalHeaders`): they are how Next's own tiers talk to each other, so honouring them
// from outside lets a client drive routing, or inject cookies through `x-middleware-set-cookie`.
const INTERNAL_REQUEST_HEADERS = [
  'x-middleware-rewrite',
  'x-middleware-redirect',
  'x-middleware-set-cookie',
  'x-middleware-skip',
  'x-middleware-override-headers',
  'x-middleware-next',
  'x-now-route-matches',
  'x-matched-path',
  'x-nextjs-data',
  'x-next-resume-state-length',
  'next-resume',
]

export function stripInternalRequestHeaders(headers: Headers): Headers {
  for (const name of INTERNAL_REQUEST_HEADERS) {
    headers.delete(name)
  }
  return headers
}

/**
 * URL to forward a matched route to: `invocationTarget` carries the concrete pathname + query after
 * rewrites (routing rules or middleware), which is also what the CDN caches by. The route module
 * gets the requested URL as `req.url` separately, see the private meta header.
 */
export function getInvocationUrl(request: Request, resolution: ResolveRoutesResult): URL {
  const url = new URL(request.url)
  if (!resolution.invocationTarget) {
    return url
  }
  const { pathname, query } = resolution.invocationTarget
  url.pathname = pathname
  url.search = ''
  for (const [key, valueOrValues] of Object.entries(query)) {
    for (const value of Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues]) {
      url.searchParams.append(key, value)
    }
  }
  return url
}

export function applyResolutionToResponse(
  request: Request,
  resolution: ResolveRoutesResult,
  response: Response,
  explicitStatus?: number,
): Response {
  const headers = new Headers(response.headers)
  const hasExplicitCacheControl = headers.has('cache-control')
  if (resolution.resolvedHeaders) {
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      const normalizedKey = key.toLowerCase()
      if (normalizedKey === 'cache-control' && hasExplicitCacheControl) {
        continue
      }
      if (normalizedKey === 'location' && resolution.redirect) {
        headers.set(key, resolution.redirect.url.toString())
        continue
      }
      if (request.headers.get(key) === value) {
        // skip echoing request headers back in response
        continue
      }
      headers.set(key, value)
    }
  }

  const finalResponse = new Response(response.body, {
    status: explicitStatus ?? resolution.status ?? response.status,
    statusText: response.statusText,
    headers,
  })

  return finalResponse
}
