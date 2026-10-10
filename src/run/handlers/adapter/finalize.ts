// L7: turns a produced response into the platform response (CDN cache control, cache tags,
// Netlify-Vary, Cache-Status), see docs/request-layers.md.
import { PPR_SHELL_HEADER } from '../../../../edge-runtime/lib/private-request-meta.ts'
import { setCacheStatusHeader, setCdnCacheControlFromNext, setVaryHeaders } from '../../headers.js'
import { encodeCacheTag } from '../tags-handler.cjs'

import { manifest } from './manifest.js'
import type { Produced, StoredCache } from './types.js'

// in minimal mode Next leaves the tags on the response instead of going through the cache handler.
// Split like the cache handler and the purge do, `%2c` included
export function getNextCacheTags(value: string): string[] {
  return value.split(/,|%2c/gi).map(encodeCacheTag)
}

function applyCacheHeaders(response: Response, request: Request) {
  const { headers } = response
  const nextCacheTags = headers.get('x-next-cache-tags')
  headers.delete('x-next-cache-tags')

  setCdnCacheControlFromNext(headers, request, null)
  if (nextCacheTags && (headers.has('cache-control') || headers.has('netlify-cdn-cache-control'))) {
    headers.set('netlify-cache-tag', getNextCacheTags(nextCacheTags).join(','))
  }
  setVaryHeaders(
    headers,
    request,
    manifest.config as Parameters<typeof setVaryHeaders>[2],
    // the routing edge function asking for a PPR page's shell is cached apart
    [PPR_SHELL_HEADER],
  )
}

// what Next's cache-control would say for this policy (`getCacheControlHeader`), for the CDN
function getCdnCacheControl({ revalidate, expire, nextCache }: StoredCache): string {
  // if we are serving already stale response, instruct edge to not attempt to cache that response
  if (nextCache === 'STALE') {
    return 'public, max-age=0, must-revalidate, durable'
  }
  const staleWhileRevalidate =
    typeof revalidate === 'number' && expire !== undefined && revalidate < expire
      ? `, stale-while-revalidate=${expire - revalidate}`
      : ''
  return `s-maxage=${revalidate === false ? 31536000 : revalidate}${staleWhileRevalidate}, durable`
}

function applyStoredCacheHeaders(response: Response, request: Request, cache: StoredCache) {
  const { headers } = response
  if (cache.revalidate === 0 || headers.has('cache-control')) {
    // a render that couldn't be stored, or routing's `headers()` replacing the store's policy
    setCdnCacheControlFromNext(headers, request, cache.nextCache)
  } else {
    headers.set('cache-control', 'public, max-age=0, must-revalidate')
    headers.set('netlify-cdn-cache-control', getCdnCacheControl(cache))
  }
  if (headers.has('cache-control') || headers.has('netlify-cdn-cache-control')) {
    headers.set('netlify-cache-tag', cache.tags.join(','))
  }
  if (cache.nextCache !== 'MISS' && cache.lastModified !== undefined) {
    headers.set('date', new Date(cache.lastModified).toUTCString())
  }
  setVaryHeaders(headers, request, manifest.config as Parameters<typeof setVaryHeaders>[2], [
    PPR_SHELL_HEADER,
  ])
  setCacheStatusHeader(headers, cache.nextCache)
}

/**
 * The one place a produced response gets its platform headers (CDN cache control, cache tags,
 * Netlify-Vary, Cache-Status), see `Produced`. `request` is the one the producer answered.
 * `routed` applies routing's response headers (`headers()` rules; middleware's are applied at the edge, after the cache) and status first, so a
 * `Cache-Control` from them is translated for the CDN like Next's own.
 */
export async function finalize(
  produced: Produced,
  request: Request,
  routed: (response: Response) => Response = (response) => response,
): Promise<Response> {
  switch (produced.kind) {
    case 'next': {
      const response = routed(produced.response)
      applyCacheHeaders(response, request)
      return response
    }
    case 'stored': {
      const { headers } = produced.response
      if (produced.cache.revalidate !== 0) {
        // the store's policy, not Next's; a Cache-Control routing adds below still wins
        headers.delete('cache-control')
        headers.delete('cdn-cache-control')
      }
      headers.delete('x-next-cache-tags')
      const response = routed(produced.response)
      applyStoredCacheHeaders(response, request, produced.cache)
      return response
    }
    case 'shell':
    case 'resume': {
      const { kind } = produced
      const response = routed(produced.response)
      const cacheControl =
        kind === 'shell'
          ? 'public, max-age=0, must-revalidate'
          : 'private, no-cache, no-store, max-age=0, must-revalidate'
      response.headers.delete('x-next-cache-tags')
      response.headers.set('cache-control', cacheControl)
      response.headers.set('netlify-cdn-cache-control', cacheControl)
      applyCacheHeaders(response, request)
      return response
    }
    case 'static-page': {
      const response = routed(produced.response)
      const { headers } = response
      // the CDN caches this for a year: without varying on the RSC headers a flight request that
      // arrives without Next's `_rsc` cache-buster would be served the HTML copy
      setVaryHeaders(headers, request, manifest.config as Parameters<typeof setVaryHeaders>[2])
      if (produced.fullyStatic) {
        headers.set('cache-control', 'public, max-age=0, must-revalidate')
        headers.set('netlify-cdn-cache-control', 'max-age=31536000, durable')
      }
      return response
    }
    case 'error': {
      const response = await finalize(produced.produced, request)
      // The error page keeps the cache headers of whatever rendered it. A static `404.html` is build
      // output that only a deploy can change, and a prerendered not-found carries its own
      // revalidate, so both are cacheable; forcing no-store here would put an origin hit on every
      // bot probe. That matches what Vercel serves for every not-found shape except a fully static
      // `pages/404.js`, which they leave uncached (measured 2026-09-18, see
      // docs/404-caching-vercel-matrix.md).
      const errorResponse = routed(
        new Response(response.body, { status: produced.status, headers: response.headers }),
      )
      // routing's Cache-Control (applied with the status) replaces the one translated above
      setCdnCacheControlFromNext(errorResponse.headers, request)
      // A cacheable 404 still has to miss for preview requests: a `fallback: false` path that is
      // not prerendered answers 404 to everyone but renders for the preview cookie, and the
      // static-file handler that produced this response only varies on the query.
      setVaryHeaders(
        errorResponse.headers,
        request,
        manifest.config as Parameters<typeof setVaryHeaders>[2],
      )
      return errorResponse
    }
    default:
      return routed(produced.response)
  }
}
