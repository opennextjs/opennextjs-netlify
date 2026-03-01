/**
 * Edge function runtime for combined routing + middleware.
 *
 * This runs at the edge before the server handler. It:
 * 1. Calls `resolveRoutes` from next-routing with an `invokeMiddleware` callback
 * 2. Handles redirects, external rewrites, and middleware responses at the edge
 * 3. For matched routes, serializes the resolution into a header and forwards
 *    the request to the server handler (or CDN for static assets)
 */
import type { Context } from '@netlify/edge-functions'

import { handleMiddlewareRaw, type NextHandler } from './middleware.ts'
import type { RequestData } from './lib/next-request.ts'

interface RoutingConfig {
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
}

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

interface MiddlewareConfig {
  enabled: boolean
  matchers?: RegExp[]
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

type MiddlewareResult = {
  bodySent?: boolean
  requestHeaders?: Headers
  responseHeaders?: Headers
  redirect?: { url: URL; status: number }
  rewrite?: URL
}

interface MiddlewareContext {
  url: URL
  headers: Headers
  requestBody: ReadableStream
}

// Pre-bundled ESM module built by tools/build.js and copied to the handler
// directory at site build time by edge-adapter.ts.
import { resolveRoutes, responseToMiddlewareResult } from '../compiled/next-routing.js'

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

// grabbed from Reference AWS Adapter and modified (fixed?)
// TODO: dedupe
function applyResolutionToResponse(
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

  console.log('final response', { inputResponse: response, finalResponse })

  return finalResponse
}

/**
 * Main entry point for the routing + middleware edge function.
 */
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

  const resolution = await resolveRoutes({
    url,
    buildId: routingConfig.buildId,
    basePath: routingConfig.basePath,
    requestBody: request.body ?? new ReadableStream(),
    headers: new Headers(request.headers),
    pathnames: routingConfig.pathnames,
    i18n: routingConfig.i18n ?? undefined,
    routes: routingConfig.routes,
    invokeMiddleware: async (middlewareCtx: MiddlewareContext) => {
      const shouldNormalize = routingConfig.routes.shouldNormalizeNextData

      console.log('invokeMiddleware', { middlewareConfig, middlewareCtx, shouldNormalize })
      if (!middlewareConfig.enabled || !middlewareConfig.load) {
        return {}
      }

      // TODO(adapter): should this be upstreamed?
      const middlewareRequestUrl = routingConfig.skipProxyUrlNormalize
        ? request.url
        : middlewareCtx.url.toString()

      // Check if request URL matches any middleware matcher
      const matchesAny = middlewareConfig.matchers?.some((re) =>
        re.test(new URL(middlewareRequestUrl).pathname),
      )
      console.log({ matchesAny })
      if (!matchesAny) {
        return {}
      }

      // Load and invoke middleware
      const handler = await middlewareConfig.load()

      // Build a Request from the middleware context to pass to handleMiddlewareRaw
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const middlewareRequest = new Request(middlewareRequestUrl, {
        headers: new Headers(middlewareCtx.headers),
        method: request.method,
        ...(hasBody ? { body: middlewareCtx.requestBody, duplex: 'half' } : {}),
      })

      const rawResponse = await handleMiddlewareRaw(middlewareRequest, context, handler, nextConfig)
      console.log({ rawResponse })

      // Convert the raw Next.js middleware response to a MiddlewareResult
      // that resolveRoutes understands
      const middlewareResult = responseToMiddlewareResult(
        rawResponse.clone(),
        new Headers(middlewareCtx.headers),
        middlewareCtx.url,
      )

      if (middlewareResult.bodySent) {
        // Store for later use if middleware sent a body response
        middlewareResponse = rawResponse
      }

      return middlewareResult
    },
  })

  const applyResolutionToThisResponse = applyResolutionToResponse.bind(null, request, resolution)

  console.log('resolution', { resolution, middlewareResponse })

  // if (middlewareResponse) {
  //   return applyResolutionToThisResponse(middlewareResponse)
  // }

  // Handle redirect — return directly from edge, no lambda needed
  if (resolution.redirect) {
    const { url: redirectUrl, status } = resolution.redirect
    const headers = new Headers()
    headers.set('location', redirectUrl.toString())
    if (resolution.resolvedHeaders) {
      for (const [key, value] of resolution.resolvedHeaders.entries()) {
        if (key.toLowerCase() !== 'location') {
          headers.set(key, value)
        }
      }
    }
    return applyResolutionToThisResponse(new Response(null, { status, headers }))
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
  // if (resolution.matchedPathname) {
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
  console.log('context.next() with forwarded request', {
    url: forwardRequest.url,
    headers: Object.fromEntries(forwardRequest.headers.entries()),
  })
  // context.next() forwards to the origin (server handler or CDN)
  return applyResolutionToThisResponse(await context.next(forwardRequest))
  // }

  // No match — pass through (edge function returns undefined = passthrough)
  // console.log('no match')
  // return applyResolutionToThisResponse(new Response('Not found (middleware)', { status: 404 }))
}
