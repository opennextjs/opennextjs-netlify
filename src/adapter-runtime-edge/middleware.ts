/**
 * Edge function runtime for combined routing + middleware.
 *
 * This runs at the edge before the server handler. It:
 * 1. Calls `resolveRoutes` from next-routing with an `invokeMiddleware` callback
 * 2. Handles redirects, external rewrites, and middleware responses at the edge
 * 3. For matched routes, serializes the resolution into a header and forwards
 *    the request to the server handler (or CDN for static assets)
 *
 * Unlike edge-runtime/routing.ts, this module has NO dependency on the
 * standalone edge-runtime directory. Middleware invocation constructs
 * RequestData directly (no geo/ip, no URL normalization — matching the
 * AWS adapter pattern).
 */
import type { Context } from '@netlify/edge-functions'

import {
  addDefaultLocaleForRouting,
  applyResolutionToResponse,
  getInvocationUrl,
  normalizeNextDataUrl,
  preferStaticPathnameAfterRewrite,
  resolveRoutes,
  responseToMiddlewareResult,
  setNextDataHeader,
} from '../adapter-runtime-shared/next-routing.js'
import type { ResolveRoutesResult } from '../adapter-runtime-shared/next-routing.js'
import { proxyExternalRewrite } from '../adapter-runtime-shared/proxy-external-rewrite.js'
// import { AdapterBuildCompleteContext } from '../adapter/adapter-output.js'

interface Route {
  source?: string
  sourceRegex: string
  destination?: string
  headers?: Record<string, string>
  has?: Array<{ type: string; key?: string; value?: string }>
  missing?: Array<{ type: string; key?: string; value?: string }>
  status?: number
  priority?: boolean
}

export interface RoutingConfig {
  buildId: string
  basePath: string
  i18n: {
    defaultLocale: string
    locales: string[]
    localeDetection?: false
    domains?: Array<{
      defaultLocale: string
      domain: string
      http?: true
      locales?: string[]
    }>
  } | null
  routes: {
    caseSensitive?: boolean
    beforeMiddleware: Array<Route>
    middlewareMatchers?: Array<Route>
    beforeFiles: Array<Route>
    afterFiles: Array<Route>
    dynamicRoutes: Array<Route>
    onMatch: Array<Route>
    fallback: Array<Route>
    shouldNormalizeNextData: boolean
  }
  pathnames: string[]
  skipProxyUrlNormalize?: boolean
}

interface RequestData {
  headers: Record<string, string>
  method: string
  url: string
  body?: ReadableStream<Uint8Array>
  nextConfig?: {
    basePath?: string
    i18n?: {
      defaultLocale: string
      localeDetection?: false
      locales: string[]
    } | null
    trailingSlash?: boolean
    skipMiddlewareUrlNormalize?: boolean
  }
}

type NextHandler = (params: { request: RequestData }) => Promise<{ response: Response }>

export interface MiddlewareConfig {
  enabled: boolean
  load?: () => Promise<NextHandler>
}

interface MiddlewareContext {
  url: URL
  headers: Headers
  requestBody: ReadableStream
}

/**
 * Serialize a ResolveRoutesResult into a header value for the server handler.
 */
function serializeResolution(resolution: ResolveRoutesResult): string {
  const serialized: Record<string, unknown> = {
    resolvedPathname: resolution.resolvedPathname ?? null,
    resolvedQuery: resolution.resolvedQuery ?? null,
    invocationTarget: resolution.invocationTarget ?? null,
    routeMatches: resolution.routeMatches ?? null,
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

  return JSON.stringify(serialized)
}

/**
 * Main entry point for the routing + middleware edge function.
 */
// eslint-disable-next-line max-params
export async function runNextRouting(
  request: Request,
  context: Context,
  routingConfig: RoutingConfig,
  middlewareConfig: MiddlewareConfig,
  nextConfig: RequestData['nextConfig'],
): Promise<Response | undefined> {
  const url = new URL(request.url)
  let middlewareResponse: Response | undefined
  // headers middleware set on its own response, e.g. `NextResponse.next({ headers })`
  let middlewareResponseHeaders: Headers | undefined
  // resolveRoutes only returns response headers, request headers modified by middleware
  // (x-middleware-override-headers / x-middleware-request-*) are applied in place to this object
  let middlewareRequestHeaders: Headers | undefined

  // Cast config values — local type definitions are intentionally loose
  // since this file runs in Deno without type-checking. The next-routing
  // package expects stricter literal types (e.g. `http?: true` vs `boolean`).
  const routingHeaders = setNextDataHeader(new Headers(request.headers), url, routingConfig)
  // A request body can only be read once, and both middleware and the origin need it. Tee it when
  // middleware actually runs (Next buffers the whole body for the same reason, see
  // `getCloneableBody`/`cloneBodyStream`) and keep the branch nobody read out of the way.
  let originBody = request.body
  const resolution = await resolveRoutes({
    url: addDefaultLocaleForRouting(url, routingConfig, routingHeaders),
    buildId: routingConfig.buildId,
    basePath: routingConfig.basePath,
    requestBody: request.body ?? new ReadableStream(),
    headers: routingHeaders,
    pathnames: routingConfig.pathnames,
    i18n: (routingConfig.i18n ?? undefined) as Parameters<typeof resolveRoutes>[0]['i18n'],
    routes: routingConfig.routes as Parameters<typeof resolveRoutes>[0]['routes'],
    invokeMiddleware: async (middlewareCtx: MiddlewareContext) => {
      // const shouldNormalize = routingConfig.routes.shouldNormalizeNextData

      if (!middlewareConfig.enabled || !middlewareConfig.load) {
        return {}
      }

      // resolveRoutes already checked middlewareMatchers, this is just building the URL middleware sees.
      // Next.js passes the URL as requested (middlewareCtx.url has default locale prefix added by resolveRoutes),
      // only normalizing data URLs unless skipMiddlewareUrlNormalize.
      const matchingUrl = normalizeNextDataUrl(url, routingConfig.basePath, routingConfig.buildId)

      if (nextConfig?.trailingSlash && !matchingUrl.pathname.endsWith('/')) {
        matchingUrl.pathname += '/'
      }

      // Load and invoke middleware directly — construct RequestData inline
      // instead of going through handleMiddlewareRaw/buildNextRequest which
      // would double-normalize URLs (routing library already normalizes).
      const handler = await middlewareConfig.load()

      const middlewareRequestUrl = nextConfig?.skipMiddlewareUrlNormalize ? url : matchingUrl

      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      let middlewareBody: ReadableStream | undefined
      if (hasBody && originBody) {
        // not middlewareCtx.requestBody: that is the very stream we handed to resolveRoutes, so
        // reading it in middleware would leave nothing for the origin
        const [forMiddleware, forOrigin] = originBody.tee()
        middlewareBody = forMiddleware
        originBody = forOrigin
      }
      const result = await handler({
        request: {
          headers: Object.fromEntries(new Headers(middlewareCtx.headers).entries()),
          method: request.method,
          url: middlewareRequestUrl.href,
          body: middlewareBody,
          nextConfig,
        },
      })
      // middleware that never read its branch would otherwise make the tee buffer the whole body
      if (middlewareBody && !middlewareBody.locked) {
        middlewareBody.cancel().catch(() => {
          // nothing to release
        })
      }
      const rawResponse = result.response

      // Convert the raw Next.js middleware response to a MiddlewareResult
      // that resolveRoutes understands
      middlewareRequestHeaders = middlewareCtx.headers
      const middlewareResult = responseToMiddlewareResult(
        rawResponse.clone(),
        middlewareRequestHeaders,
        middlewareCtx.url,
      )

      if (
        middlewareResult.redirect &&
        [url.href, middlewareRequestUrl.href].includes(middlewareResult.redirect.url.href)
      ) {
        // same as the standalone edge runtime: a redirect to the requested URL would loop in the
        // browser, so treat it as next() and still apply the response headers (e.g. cookies meant to
        // change the next request)
        delete middlewareResult.redirect
        middlewareResult.responseHeaders?.delete('location')
      }

      middlewareResponseHeaders = middlewareResult.responseHeaders

      if (middlewareResult.bodySent) {
        // Store for later use if middleware sent a body response
        middlewareResponse = rawResponse
      }

      return middlewareResult
    },
  }).then((resolved) => preferStaticPathnameAfterRewrite(resolved, url, routingConfig))

  const applyResolutionToThisResponse = applyResolutionToResponse.bind(null, request, resolution)

  // Handle redirect — return directly from edge, no lambda needed
  if (resolution.redirect) {
    const { status } = resolution.redirect
    return applyResolutionToThisResponse(new Response(null, { status }))
  }

  // Handle external rewrite — fetch directly from edge
  if (resolution.externalRewrite) {
    try {
      // request headers set by middleware (`NextResponse.rewrite(url, { request: { headers } })`)
      const externalRequest =
        middlewareRequestHeaders || originBody !== request.body
          ? new Request(request, {
              headers: middlewareRequestHeaders ?? request.headers,
              body: originBody,
              // @ts-expect-error duplex is needed for streaming bodies
              duplex: 'half',
            })
          : request
      return applyResolutionToThisResponse(
        await proxyExternalRewrite(resolution.externalRewrite, externalRequest),
      )
    } catch (error) {
      console.error('external rewrite fetch error', error)
      return new Response('Bad Gateway', { status: 502 })
    }
  }

  // Handle middleware that sent a body response (e.g. NextResponse.json())
  if (resolution.middlewareResponded && middlewareResponse) {
    return applyResolutionToThisResponse(middlewareResponse)
  }

  // Check for redirect via resolved headers (e.g. location header set by routing rules)
  if (resolution.status && resolution.status >= 300 && resolution.status < 400) {
    const location = resolution.resolvedHeaders?.get('location')
    if (location) {
      const headers = new Headers()
      if (resolution.resolvedHeaders) {
        for (const [key, value] of resolution.resolvedHeaders.entries()) {
          headers.set(key, value)
        }
      }
      return applyResolutionToThisResponse(
        new Response(null, { status: resolution.status, headers }),
      )
    }
  }

  // Matched a pathname — forward to server handler or CDN with resolution header
  const serialized = serializeResolution(resolution)

  // Clone the request, potentially adjusting URL for rewrites
  const forwardHeaders = new Headers(middlewareRequestHeaders ?? routingHeaders)
  forwardHeaders.set('x-next-route-resolution', serialized)
  // the forwarded URL is the rewrite target (so the CDN can cache by it), the server handler still
  // needs the URL the client requested because that's what Next's route modules expect as req.url
  forwardHeaders.set('x-next-public-url', request.url)

  // Apply any request headers from middleware
  if (resolution.resolvedHeaders) {
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      // Only forward request-modifying headers, not response headers
      // The server handler will apply response headers from the serialized resolution
      forwardHeaders.set(key, value)
    }
  }

  const forwardRequest = new Request(
    getInvocationUrl(request, resolution, {
      ...routingConfig,
      trailingSlash: nextConfig?.trailingSlash,
    }),
    {
      method: request.method,
      headers: forwardHeaders,
      body: originBody,
      // @ts-expect-error duplex is needed for streaming bodies
      duplex: 'half',
    },
  )
  // context.next() forwards to the origin (server handler or CDN)
  const originResponse = applyResolutionToThisResponse(await context.next(forwardRequest))

  // Next applies the middleware response headers to the final response, and they win over what the
  // origin sent: `applyResolutionToResponse` keeps an origin cache-control (a CDN-served static
  // file carries the one we configured for it at build time), middleware asking for another one is
  // the whole point of `NextResponse.next({ headers: { 'cache-control': … } })`.
  if (!middlewareResponseHeaders) {
    return originResponse
  }
  const headers = new Headers(originResponse.headers)
  for (const [key, value] of middlewareResponseHeaders.entries()) {
    if (key.toLowerCase().startsWith('x-middleware-')) {
      continue
    }
    headers.set(key, value)
  }
  return new Response(originResponse.body, {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers,
  })
}
