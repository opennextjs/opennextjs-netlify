// L7: turns a produced response into the platform response (CDN cache control, cache tags,
// Netlify-Vary, Cache-Status), see docs/request-layers.md.
import { PPR_SHELL_HEADER } from '../../../../edge-runtime/lib/private-request-meta.ts'
import {
  setCacheStatusHeader,
  setCdnCacheControlFromNext,
  setDateFromLastModified,
  setVaryHeaders,
} from '../../headers.js'
import { encodeCacheTag } from '../tags-handler.cjs'

import { manifest } from './manifest.js'
import type { CacheInputs, Produced } from './types.js'

function applyCacheHeaders(response: Response, request: Request, cache: CacheInputs = {}) {
  const { headers } = response
  // in minimal mode Next leaves the tags on the response instead of going through the cache handler
  const nextCacheTags = headers.get('x-next-cache-tags')
  // split like the cache handler and the purge do, `%2c` included
  const tags = nextCacheTags ? nextCacheTags.split(/,|%2c/gi).map(encodeCacheTag) : cache.tags
  headers.delete('x-next-cache-tags')

  const nextCache = headers.get('x-nextjs-cache')
  if ((nextCache === 'HIT' || nextCache === 'STALE') && cache.lastModified) {
    setDateFromLastModified(headers, cache.lastModified)
  }
  setCdnCacheControlFromNext(headers, request)
  if (tags && (headers.has('cache-control') || headers.has('netlify-cdn-cache-control'))) {
    headers.set('netlify-cache-tag', tags.join(','))
  }
  setVaryHeaders(
    headers,
    request,
    manifest.config as Parameters<typeof setVaryHeaders>[2],
    // the routing edge function asking for a PPR page's shell is cached apart
    [PPR_SHELL_HEADER],
  )
  setCacheStatusHeader(headers, nextCache)
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
      applyCacheHeaders(response, request, produced.cache)
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
