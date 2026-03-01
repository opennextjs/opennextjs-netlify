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
  applyResolutionToResponse,
  matchRoute,
  normalizeNextDataUrl,
  resolveRoutes,
  responseToMiddlewareResult,
} from '../adapter-runtime-shared/next-routing.js'
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
      http?: boolean
      locales?: string[]
    }>
  } | null
  routes: {
    beforeMiddleware: Array<Route>
    beforeFiles: Array<Route>
    afterFiles: Array<Route>
    dynamicRoutes: Array<Route>
    onMatch: Array<Route>
    fallback: Array<Route>
    shouldNormalizeNextData: boolean
  }
  pathnames: string[]
  skipProxyUrlNormalize?: boolean
  middlewareMatchers: Route[]
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

interface ResolveRoutesResult {
  middlewareResponded?: boolean
  externalRewrite?: URL
  redirect?: { url: URL; status: number }
  matchedPathname?: string
  resolvedHeaders?: Headers
  status?: number
  routeMatches?: Record<string, string>
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
    matchedPathname: resolution.matchedPathname ?? null,
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
  console.log('running new edge handler', {
    url: request.url,
  })
  const url = new URL(request.url)
  let middlewareResponse: Response | undefined

  // Cast config values — local type definitions are intentionally loose
  // since this file runs in Deno without type-checking. The next-routing
  // package expects stricter literal types (e.g. `http?: true` vs `boolean`).
  const resolution = await resolveRoutes({
    url,
    buildId: routingConfig.buildId,
    basePath: routingConfig.basePath,
    requestBody: request.body ?? new ReadableStream(),
    headers: new Headers(request.headers),
    pathnames: routingConfig.pathnames,
    i18n: (routingConfig.i18n ?? undefined) as Parameters<typeof resolveRoutes>[0]['i18n'],
    routes: routingConfig.routes as Parameters<typeof resolveRoutes>[0]['routes'],
    invokeMiddleware: async (middlewareCtx: MiddlewareContext) => {
      // const shouldNormalize = routingConfig.routes.shouldNormalizeNextData

      // console.log('invokeMiddleware', { middlewareConfig, middlewareCtx, shouldNormalize })
      if (!middlewareConfig.enabled || !middlewareConfig.load) {
        return {}
      }

      // matching is done by testing normalized url
      const matchingUrl = normalizeNextDataUrl(
        middlewareCtx.url,
        routingConfig.basePath,
        routingConfig.buildId,
      )

      if (nextConfig?.trailingSlash && !matchingUrl.pathname.endsWith('/')) {
        matchingUrl.pathname += '/'
      }

      const matchesAny = routingConfig.middlewareMatchers.some((matcher) => {
        // @ts-expect-error matcher types
        const { matched } = matchRoute(matcher, middlewareCtx.url, middlewareCtx.headers)
        return matched
      })

      // console.log({ matchingUrl, matchers: routingConfig.middlewareMatchers, matchesAny })
      if (!matchesAny) {
        return {}
      }

      // Load and invoke middleware directly — construct RequestData inline
      // instead of going through handleMiddlewareRaw/buildNextRequest which
      // would double-normalize URLs (routing library already normalizes).
      const handler = await middlewareConfig.load()

      const middlewareRequestUrl = nextConfig?.skipMiddlewareUrlNormalize
        ? middlewareCtx.url
        : matchingUrl

      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const result = await handler({
        request: {
          headers: Object.fromEntries(new Headers(middlewareCtx.headers).entries()),
          method: request.method,
          url: middlewareRequestUrl.href,
          body: hasBody ? middlewareCtx.requestBody : undefined,
          nextConfig,
        },
      })
      const rawResponse = result.response

      // console.log({ rawResponse })

      // Convert the raw Next.js middleware response to a MiddlewareResult
      // that resolveRoutes understands
      const middlewareResult = responseToMiddlewareResult(
        rawResponse.clone(),
        new Headers(middlewareCtx.headers),
        middlewareCtx.url,
      )

      // console.log({ middlewareResult })

      if (middlewareResult.bodySent) {
        // Store for later use if middleware sent a body response
        middlewareResponse = rawResponse
      }

      return middlewareResult
    },
  })

  const applyResolutionToThisResponse = applyResolutionToResponse.bind(null, request, resolution)

  // console.log('resolution', {
  //   resolution,
  //   middlewareResponse,
  //   body: await middlewareResponse?.clone().text(),
  // })

  // Handle redirect — return directly from edge, no lambda needed
  if (resolution.redirect) {
    const { status } = resolution.redirect
    return applyResolutionToThisResponse(new Response(null, { status }))
  }

  // Handle external rewrite — fetch directly from edge
  if (resolution.externalRewrite) {
    try {
      const proxyRequest = new Request(resolution.externalRewrite.toString(), request)
      // Remove Netlify internal headers
      for (const key of request.headers.keys()) {
        if (key.startsWith('x-nf-')) {
          proxyRequest.headers.delete(key)
        }
      }
      const fetchResp = await fetch(proxyRequest, { redirect: 'manual' })
      console.log({
        fetchResp,
        spreadResp: { ...fetchResp },
        spreadRespKeys: Object.keys({ ...fetchResp }),
      })
      const headers = new Headers(fetchResp.headers)
      headers.delete('transfer-encoding')
      headers.delete('content-encoding')
      headers.delete('content-length')
      return applyResolutionToThisResponse(
        new Response(fetchResp.body, {
          headers,
          status: fetchResp.status,
          statusText: fetchResp.statusText,
        }),
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
  const forwardHeaders = new Headers(request.headers)
  forwardHeaders.set('x-next-route-resolution', serialized)

  // Apply any request headers from middleware
  if (resolution.resolvedHeaders) {
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      // Only forward request-modifying headers, not response headers
      // The server handler will apply response headers from the serialized resolution
      forwardHeaders.set(key, value)
    }
  }

  const forwardRequest = new Request(request.url, {
    method: request.method,
    headers: forwardHeaders,
    body: request.body,
    // @ts-expect-error duplex is needed for streaming bodies
    duplex: 'half',
  })
  // console.log('context.next() with forwarded request', {
  //   url: forwardRequest.url,
  //   headers: Object.fromEntries(forwardRequest.headers.entries()),
  // })
  // context.next() forwards to the origin (server handler or CDN)
  return applyResolutionToThisResponse(await context.next(forwardRequest))
}
