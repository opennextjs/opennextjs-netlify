import { resolveRoutes } from '@next/routing'
import type { ResolveRoutesParams, ResolveRoutesResult } from '@next/routing'

import { proxyExternalRewrite } from './proxy-external-rewrite.js'

export { responseToMiddlewareResult } from '@next/routing'
export type { ResolveRoutesParams, ResolveRoutesResult } from '@next/routing'

/**
 * What `resolveRoutes` takes from the build. Produced once (getRoutingConfig) for both the routing
 * edge function and the server handler, so they resolve the same way.
 */
export type RoutingConfig = Pick<
  ResolveRoutesParams,
  | 'buildId'
  | 'basePath'
  | 'pathnames'
  | 'trailingSlash'
  | 'skipMiddlewareUrlNormalize'
  | 'i18n'
  | 'routes'
> & {
  // static outputs whose file is published under another name than their pathname (getPublishedPath)
  publishedPaths: Record<string, string>
}

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

/**
 * `resolveRoutes` with the build's routing config, for both the routing edge function (which runs
 * middleware) and the server handler without one in front (`invokeMiddleware` stays a no-op).
 */
export function resolve(
  { url, headers, requestBody }: Pick<ResolveRoutesParams, 'url' | 'headers' | 'requestBody'>,
  config: RoutingConfig,
  invokeMiddleware: ResolveRoutesParams['invokeMiddleware'] = async () => ({}),
): Promise<ResolveRoutesResult> {
  return resolveRoutes({ ...config, url, headers, requestBody, invokeMiddleware })
}

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
export function getInvocationUrl(
  request: Request,
  resolution: ResolveRoutesResult,
  publishedPaths: RoutingConfig['publishedPaths'],
): URL {
  const url = new URL(request.url)
  if (!resolution.invocationTarget) {
    return url
  }
  const { pathname, query } = resolution.invocationTarget
  // a static output by the name its file is published under: the route's pathname would get the
  // CDN's own URL normalization (pretty URLs, lowercasing, encoding), answered with a redirect
  url.pathname =
    (resolution.resolvedPathname && publishedPaths[resolution.resolvedPathname]) || pathname
  url.search = ''
  for (const [key, valueOrValues] of Object.entries(query)) {
    for (const value of Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues]) {
      url.searchParams.append(key, value)
    }
  }
  return url
}

// URL keeps `[`/`]` raw, but the CDN only finds a static file by its encoded name and answers the
// raw form with a 301 to it. Only for requesting a static output's file: a forwarded rewrite target
// must not match one, or the CDN's canonical redirect reaches the client.
export function encodeRouteBrackets(pathname: string): string {
  return pathname.replaceAll('[', '%5B').replaceAll(']', '%5D')
}

/**
 * Like Vercel's `__next_data_catchall`: with middleware, a data request no output matched gets an
 * empty JSON instead of a 404, so the client still gets middleware's effects (a rewrite to a page
 * without a data route, say). `requestedUrl` is the URL as requested, not the rewrite target.
 */
export function isUnmatchedNextDataRequest(
  requestedUrl: URL,
  resolution: ResolveRoutesResult,
  {
    basePath,
    buildId,
    middlewareMatchers,
  }: { basePath: string; buildId: string; middlewareMatchers?: unknown[] },
): boolean {
  return (
    (middlewareMatchers?.length ?? 0) > 0 &&
    !resolution.resolvedPathname &&
    !resolution.redirect &&
    !resolution.externalRewrite &&
    !resolution.middlewareResponded &&
    requestedUrl.pathname.startsWith(`${basePath}/_next/data/${buildId}/`)
  )
}

/**
 * `next start` (`base-server`) and Vercel's routes tell the client router which page a data request
 * rendered, the rewrite target included: `/<locale><page>`. It needs it where the response itself
 * can't say, like an automatically static page's HTML answering a data request.
 */
function getNextDataMatchedPath(
  resolution: ResolveRoutesResult,
  basePath: string,
): string | undefined {
  const { resolvedPathname, invocation } = resolution
  if (!resolvedPathname || !invocation?.headers['x-nextjs-data']) {
    return
  }
  let pathname =
    basePath && resolvedPathname.startsWith(basePath)
      ? resolvedPathname.slice(basePath.length) || '/'
      : resolvedPathname
  const data = /^\/_next\/data\/[^/]+\/(.+)\.json$/.exec(pathname)
  if (data) {
    pathname = data[1] === 'index' ? '/' : `/${data[1]}`
  }
  const { locale } = invocation.requestMeta
  if (locale && pathname !== `/${locale}` && !pathname.startsWith(`/${locale}/`)) {
    pathname = `/${locale}${pathname === '/' ? '' : pathname}`
  }
  return pathname
}

export function applyResolutionToResponse(
  {
    request,
    resolution,
    basePath,
    routingCacheControlWins,
  }: {
    request: Request
    resolution: ResolveRoutesResult
    basePath: string
    // a response Next rendered: like `next start`, which sets routing's headers before rendering and
    // only adds its own Cache-Control (and CDN-Cache-Control) when none is set yet (send-payload.ts).
    // Otherwise the origin's wins, e.g. what we configured for a CDN-served static file at build time
    routingCacheControlWins?: boolean
  },
  response: Response,
  explicitStatus?: number,
): Response {
  const headers = new Headers(response.headers)
  const hasExplicitCacheControl = headers.has('cache-control')
  if (resolution.resolvedHeaders) {
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      const normalizedKey = key.toLowerCase()
      if (normalizedKey === 'cache-control') {
        if (hasExplicitCacheControl && !routingCacheControlWins) {
          continue
        }
        // the CDN policy derived from the replaced Cache-Control goes with it (an error page is
        // translated before it gets its status and routing's headers)
        headers.delete('cdn-cache-control')
        headers.delete('netlify-cdn-cache-control')
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

  const status = explicitStatus ?? resolution.status ?? response.status
  const matchedPath = status === 200 ? getNextDataMatchedPath(resolution, basePath) : undefined
  if (matchedPath && !headers.has('x-nextjs-matched-path')) {
    // header values can't carry non-Latin-1 characters (`/products/事前レンダリング`)
    headers.set(
      'x-nextjs-matched-path',
      matchedPath.replace(/[^\t\u0020-\u007E]+/g, (run) => encodeURIComponent(run)),
    )
  }

  const finalResponse = new Response(response.body, {
    status,
    statusText: response.statusText,
    headers,
  })

  return finalResponse
}

/**
 * What routing answers on its own, without invoking an output: redirects (explicit, or a 3xx with a
 * `location` from routing rules or middleware), external rewrites and a middleware response with a
 * body. `outgoingRequest` builds what an external rewrite proxies: the request without Next's
 * internal headers, with middleware's request header overrides. A function so the body is only
 * attached when it is proxied.
 */
export async function answerWithoutCompute(
  resolution: ResolveRoutesResult,
  {
    request,
    outgoingRequest,
    basePath,
    middlewareResponse,
  }: {
    request: Request
    outgoingRequest: () => Request
    basePath: string
    middlewareResponse?: Response
  },
): Promise<Response | undefined> {
  const apply = applyResolutionToResponse.bind(null, { request, resolution, basePath })

  // TODO(adapter): redirects can be cached forever, but the routing rules involved may depend on
  // headers or other request properties, which would need the right `netlify-vary`
  if (resolution.redirect) {
    const { url, status } = resolution.redirect
    return apply(new Response(null, { status, headers: { location: url.toString() } }))
  }

  if (resolution.externalRewrite) {
    try {
      return apply(await proxyExternalRewrite(resolution.externalRewrite, outgoingRequest()))
    } catch (error) {
      console.error('external rewrite fetch error', error)
      return new Response('Bad Gateway', { status: 502 })
    }
  }

  if (resolution.middlewareResponded && middlewareResponse) {
    return apply(middlewareResponse)
  }

  const { status, resolvedHeaders } = resolution
  if (status && status >= 300 && status < 400 && resolvedHeaders?.get('location')) {
    return apply(new Response(null, { status }), status)
  }
}

// The handoff (L2): the routing edge function sends its resolution to the server handler in the
// private meta header instead of the server routing a second time.

/**
 * Serialize a ResolveRoutesResult into a header value for the server handler.
 */
export function serializeResolution(resolution: ResolveRoutesResult): string {
  const serialized: Record<string, unknown> = {
    resolvedPathname: resolution.resolvedPathname ?? null,
    resolvedQuery: resolution.resolvedQuery ?? null,
    invocationTarget: resolution.invocationTarget ?? null,
    routeMatches: resolution.routeMatches ?? null,
    invocation: resolution.invocation ?? null,
    status: resolution.status ?? null,
    redirect: null,
    externalRewrite: null,
    middlewareResponded: resolution.middlewareResponded ?? false,
  }

  // Serialize Headers to plain object
  if (resolution.resolvedHeaders) {
    const headers: Record<string, string> = {}
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      headers[key] = value
    }
    serialized.resolvedHeaders = headers
  } else {
    serialized.resolvedHeaders = null
  }

  if (resolution.redirect) {
    serialized.redirect = {
      url: resolution.redirect.url.toString(),
      status: resolution.redirect.status,
    }
  }

  if (resolution.externalRewrite) {
    serialized.externalRewrite = resolution.externalRewrite.toString()
  }

  // The resolution travels in a header, and headers are ByteStrings: a non-ASCII character
  // anywhere in it (a unicode search param, say) makes `Headers.set` throw. JSON's own `\uXXXX`
  // escapes keep it ASCII and `JSON.parse` turns them back into the original characters.
  return JSON.stringify(serialized).replace(
    /[\u0080-\uFFFF]/g,
    (character) => `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0')}`,
  )
}

/**
 * Deserialize a ResolveRoutesResult from the private meta header the edge function sets.
 * The routing edge function serializes the resolution as JSON with
 * Headers → plain object, URL → string conversions.
 */
export function deserializeResolution(serialized: string): ResolveRoutesResult {
  const parsed = JSON.parse(serialized) as {
    resolvedPathname: string | null
    resolvedQuery: ResolveRoutesResult['resolvedQuery'] | null
    invocationTarget: ResolveRoutesResult['invocationTarget'] | null
    routeMatches: Record<string, string> | null
    invocation?: ResolveRoutesResult['invocation'] | null
    resolvedHeaders: Record<string, string> | null
    status: number | null
    redirect: { url: string; status: number } | null
    externalRewrite: string | null
    middlewareResponded: boolean
  }

  const resolution: ResolveRoutesResult = {}

  if (parsed.resolvedPathname !== null) {
    resolution.resolvedPathname = parsed.resolvedPathname
  }
  if (parsed.resolvedQuery !== null) {
    resolution.resolvedQuery = parsed.resolvedQuery
  }
  if (parsed.invocationTarget !== null) {
    resolution.invocationTarget = parsed.invocationTarget
  }
  if (parsed.routeMatches !== null) {
    resolution.routeMatches = parsed.routeMatches
  }
  if (parsed.invocation) {
    resolution.invocation = parsed.invocation
  }
  if (parsed.status !== null) {
    resolution.status = parsed.status
  }
  if (parsed.middlewareResponded) {
    resolution.middlewareResponded = parsed.middlewareResponded
  }
  if (parsed.resolvedHeaders !== null) {
    const headers = new Headers()
    for (const [key, value] of Object.entries(parsed.resolvedHeaders)) {
      headers.set(key, value)
    }
    resolution.resolvedHeaders = headers
  }
  if (parsed.redirect !== null) {
    resolution.redirect = {
      url: new URL(parsed.redirect.url),
      status: parsed.redirect.status,
    }
  }
  if (parsed.externalRewrite !== null) {
    resolution.externalRewrite = new URL(parsed.externalRewrite)
  }

  return resolution
}
