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
 * standalone edge-runtime directory. Middleware is invoked through the entry's
 * documented handler (no geo/ip, no URL normalization — matching the AWS
 * adapter pattern).
 */
import type { Context } from '@netlify/edge-functions'

import {
  REQUEST_META_HEADER,
  type RequestMeta,
} from '../../edge-runtime/lib/private-request-meta.ts'
import {
  answerWithoutCompute,
  applyResolutionToResponse,
  getInvocationUrl,
  isUnmatchedNextDataRequest,
  resolve,
  responseToMiddlewareResult,
  serializeResolution,
  stripInternalRequestHeaders,
} from '../adapter-runtime-shared/next-routing.js'
import type { RoutingConfig } from '../adapter-runtime-shared/next-routing.js'
// import { AdapterBuildCompleteContext } from '../adapter/adapter-output.js'

const REWRITE_HEADERS = new Set(['x-nextjs-rewritten-path', 'x-nextjs-rewritten-query'])

// an edge entry's `edgeRuntime.handlerExport` (Next's adapter docs, "Invoking entrypoints")
type NextHandler = (
  request: Request,
  ctx: { waitUntil?: (promise: Promise<unknown>) => void; signal?: AbortSignal },
) => Promise<Response>

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
 * Main entry point for the routing + middleware edge function.
 */
export async function runNextRouting(
  request: Request,
  context: Context,
  routingConfig: RoutingConfig,
  middlewareConfig: MiddlewareConfig,
): Promise<Response | undefined> {
  const url = new URL(request.url)
  let middlewareResponse: Response | undefined
  // headers middleware set on its own response, e.g. `NextResponse.next({ headers })`
  let middlewareResponseHeaders: Headers | undefined
  // resolveRoutes only returns response headers, request headers modified by middleware
  // (x-middleware-override-headers / x-middleware-request-*) are applied in place to this object
  let middlewareRequestHeaders: Headers | undefined

  // the edge function is where a request enters, so this is the boundary Next's router-server
  // filters at; `resolveRoutes` sets `x-nextjs-data` back from the URL
  // only this function may set the private meta header, a client must not be able to pre-populate
  // it (nor middleware copy it into its request header overrides)
  request.headers.delete(REQUEST_META_HEADER)

  const routingHeaders = stripInternalRequestHeaders(new Headers(request.headers))
  // A request body can only be read once, and both middleware and the origin need it. Tee it when
  // middleware actually runs (Next buffers the whole body for the same reason, see
  // `getCloneableBody`/`cloneBodyStream`) and keep the branch nobody read out of the way.
  let originBody = request.body
  const resolution = await resolve(
    { url, headers: routingHeaders, requestBody: request.body ?? new ReadableStream() },
    routingConfig,
    async (middlewareCtx: MiddlewareContext) => {
      // const shouldNormalize = routingConfig.routes.shouldNormalizeNextData

      if (!middlewareConfig.enabled || !middlewareConfig.load) {
        return {}
      }

      // resolveRoutes already checked middlewareMatchers. `middlewareCtx.url` is the URL as
      // requested, as Next passes it: Next's middleware adapter normalizes data URLs and the
      // trailing slash itself (from `x-nextjs-data` and `nextConfig`).
      // Invoke middleware directly instead of going through handleMiddlewareRaw/buildNextRequest,
      // which would double-normalize URLs (routing library already normalizes).
      const handler = await middlewareConfig.load()

      const middlewareRequestUrl = middlewareCtx.url

      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      let middlewareBody: ReadableStream | undefined
      if (hasBody && originBody) {
        // not middlewareCtx.requestBody: that is the very stream we handed to resolveRoutes, so
        // reading it in middleware would leave nothing for the origin
        const [forMiddleware, forOrigin] = originBody.tee()
        middlewareBody = forMiddleware
        originBody = forOrigin
      }
      // the entry's documented handler: it passes background work to `waitUntil` itself
      const rawResponse = await handler(
        new Request(middlewareRequestUrl, {
          headers: middlewareCtx.headers,
          method: request.method,
          body: middlewareBody,
          // @ts-expect-error duplex is needed for streaming bodies
          duplex: 'half',
        }),
        { waitUntil: context.waitUntil?.bind(context), signal: request.signal },
      )
      // middleware that never read its branch would otherwise make the tee buffer the whole body
      if (middlewareBody && !middlewareBody.locked) {
        middlewareBody.cancel().catch(() => {
          // nothing to release
        })
      }

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
  )

  const applyResolutionToThisResponse = applyResolutionToResponse.bind(null, {
    request,
    resolution,
    basePath: routingConfig.basePath,
  })

  const answered = await answerWithoutCompute(resolution, {
    request,
    basePath: routingConfig.basePath,
    middlewareResponse,
    // request headers set by middleware (`NextResponse.rewrite(url, { request: { headers } })`)
    outgoingRequest: () =>
      new Request(request, {
        headers: middlewareRequestHeaders ?? routingHeaders,
        body: originBody,
        // @ts-expect-error duplex is needed for streaming bodies
        duplex: 'half',
      }),
  })
  if (answered) {
    return answered
  }

  // Next applies the middleware response headers to the final response, and they win over what the
  // origin sent: `applyResolutionToResponse` keeps an origin cache-control (a CDN-served static
  // file carries the one we configured for it at build time), middleware asking for another one is
  // the whole point of `NextResponse.next({ headers: { 'cache-control': … } })`.
  // TODO(adapter): for a response the server handler produced, it already applied middleware's
  // cache-control (routing wins, translated for the CDN); re-applying it here only puts the raw value
  // back on the browser header. Telling function from CDN responses apart here needs a reliable signal.
  const withMiddlewareResponseHeaders = (response: Response) => {
    if (!middlewareResponseHeaders) {
      return response
    }
    const headers = new Headers(response.headers)
    for (const [key, value] of middlewareResponseHeaders.entries()) {
      if (key.toLowerCase().startsWith('x-middleware-')) {
        continue
      }
      // a later rewrite (an interception route, say) replaces the middleware's rewrite headers, as
      // Next's router does
      const resolvedValue = REWRITE_HEADERS.has(key.toLowerCase())
        ? resolution.resolvedHeaders?.get(key)
        : undefined
      headers.set(key, resolvedValue ?? value)
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  if (
    isUnmatchedNextDataRequest(url, resolution, {
      basePath: routingConfig.basePath,
      buildId: routingConfig.buildId,
      middlewareMatchers: routingConfig.routes.middlewareMatchers,
    })
  ) {
    return withMiddlewareResponseHeaders(applyResolutionToThisResponse(Response.json({})))
  }

  // Matched a pathname — forward to server handler or CDN with the routing result
  const serialized = serializeResolution(resolution)

  // Clone the request, potentially adjusting URL for rewrites
  const forwardHeaders = new Headers(middlewareRequestHeaders ?? routingHeaders)
  // The forwarded URL is the rewrite target (so the CDN can cache by it); the server handler needs
  // the URL the client requested because that's what Next's route modules expect as `req.url`, and
  // the resolution so it doesn't route a second time. Both ride in the private meta header, which
  // the handler only honours when the request id in it matches the platform's - a client can't
  // predict that, so it can't hand the handler a routing result of its own choosing.
  const requestID = request.headers.get('x-nf-request-id')
  if (requestID) {
    const meta: RequestMeta = {
      requestID,
      publicUrl: request.url,
      routeResolution: serialized,
    }
    forwardHeaders.set(REQUEST_META_HEADER, JSON.stringify(meta))
  }

  // Apply any request headers from middleware
  if (resolution.resolvedHeaders) {
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      // Only forward request-modifying headers, not response headers
      // The server handler will apply response headers from the serialized resolution
      forwardHeaders.set(key, value)
    }
  }

  const forwardRequest = new Request(getInvocationUrl(request, resolution), {
    method: request.method,
    headers: forwardHeaders,
    body: originBody,
    // @ts-expect-error duplex is needed for streaming bodies
    duplex: 'half',
  })
  // context.next() forwards to the origin (server handler or CDN)
  return withMiddlewareResponseHeaders(
    applyResolutionToThisResponse(await context.next(forwardRequest)),
  )
}
