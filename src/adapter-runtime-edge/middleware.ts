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
  POSTPONED_LENGTH_HEADER,
  PPR_SHELL_HEADER,
  REQUEST_META_HEADER,
  type RequestMeta,
} from '../../edge-runtime/lib/private-request-meta.ts'
import {
  answerWithoutCompute,
  applyResolutionToResponse,
  getInvocationUrl,
  isUnmatchedNextDataRequest,
  matchesHas,
  resolve,
  responseToMiddlewareResult,
  serializeResolution,
  stripInternalRequestHeaders,
  withFlightVary,
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
  request.headers.delete(PPR_SHELL_HEADER)

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

  // Middleware's response headers are applied here, after the CDN cache, and nowhere else:
  // `@next/routing` keeps them out of `resolvedHeaders`, so the handoff (and what the server handler
  // returns for the CDN to cache) only carries the routing rules' headers. As in Next, they win over
  // what the origin sent, cache-control included (`NextResponse.next({ headers: { … } })`).
  const withMiddlewareResponseHeaders = (response: Response) => {
    if (!middlewareResponseHeaders) {
      return response
    }
    const headers = new Headers(response.headers)
    for (const [key, value] of middlewareResponseHeaders.entries()) {
      if (key.toLowerCase().startsWith('x-middleware-')) {
        continue
      }
      // iteration yields each cookie on its own, so `set` would keep only the last one
      if (key.toLowerCase() === 'set-cookie') {
        headers.append(key, value)
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
    // a response middleware returned already carries its headers
    return resolution.middlewareResponded ? answered : withMiddlewareResponseHeaders(answered)
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
  // A compressed origin response is decompressed in the isolate, and that decoder hands on one
  // 4096-byte buffer per input chunk, holding back the rest of a streamed flush (a page's shell or
  // `loading.js` would arrive with the end of the response). The platform compresses what the edge
  // function returns for the client.
  forwardHeaders.set('accept-encoding', 'identity')
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

  const invocationUrl = getInvocationUrl(request, resolution, routingConfig.publishedPaths)
  const ppr = resolution.resolvedPathname
    ? routingConfig.ppr[resolution.resolvedPathname]
    : undefined
  if (
    ppr &&
    ['GET', 'HEAD'].includes(request.method) &&
    !request.headers.has('rsc') &&
    !(ppr.bypassFor ?? []).some((has) => matchesHas(has, request, url))
  ) {
    forwardHeaders.set(PPR_SHELL_HEADER, '1')
    const shell = await context.next(
      new Request(invocationUrl, { method: request.method, headers: forwardHeaders }),
    )
    forwardHeaders.delete(PPR_SHELL_HEADER)
    const composed = await composePPR(shell, request, (postponed) =>
      context.next(
        new Request(invocationUrl, {
          method: 'POST',
          headers: { ...Object.fromEntries(forwardHeaders), ...ppr.resumeHeaders },
          body: postponed,
        }),
      ),
    )
    return withMiddlewareResponseHeaders(applyResolutionToThisResponse(composed))
  }

  const forwardRequest = new Request(invocationUrl, {
    method: request.method,
    headers: forwardHeaders,
    body: originBody,
    // @ts-expect-error duplex is needed for streaming bodies
    duplex: 'half',
  })
  // context.next() forwards to the origin (server handler or CDN). We only change headers of what it
  // returns, so the origin may answer a conditional request with a 304, unless routing sets the
  // status (a 404 page), which would replace the 304.
  const response = await context.next(forwardRequest, {
    sendConditionalRequest: resolution.status === undefined,
  })
  return withMiddlewareResponseHeaders(
    applyResolutionToThisResponse(withFlightVary(request, response)),
  )
}

/**
 * PPR at the edge: the shell response (cached by the CDN like the page's shell) starts with the
 * postponed state, its length in `POSTPONED_LENGTH_HEADER`. The shell goes to the client right away
 * and the resumed render streams after it. Anything else (a page that turned out not to postpone)
 * is passed through as is.
 */
async function composePPR(
  shell: Response,
  request: Request,
  resume: (postponed: Uint8Array<ArrayBuffer>) => Promise<Response>,
): Promise<Response> {
  const length = Number(shell.headers.get(POSTPONED_LENGTH_HEADER))
  if (!shell.body || !shell.headers.has(POSTPONED_LENGTH_HEADER) || !Number.isInteger(length)) {
    return shell
  }
  const headers = new Headers(shell.headers)
  headers.delete(POSTPONED_LENGTH_HEADER)
  headers.delete('content-length')
  // the page is per request, only its shell is cached
  headers.set('cache-control', 'private, no-cache, no-store, max-age=0, must-revalidate')
  if (request.method === 'HEAD') {
    await shell.body.cancel()
    return new Response(null, { status: shell.status, headers })
  }

  const reader = shell.body.getReader()
  let buffered: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  while (buffered.byteLength < length) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    const next = new Uint8Array(buffered.byteLength + value.byteLength)
    next.set(buffered)
    next.set(value, buffered.byteLength)
    buffered = next
  }
  const postponed = buffered.slice(0, length)
  const shellChunks = [buffered.slice(length)]
  if (request.headers.has('x-nf-debug-logging')) {
    // where the shell ends and the resumed render starts: the whole (cached) shell is read before
    // responding, so its length can go in a header
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      shellChunks.push(value)
    }
    headers.set(
      'x-next-ppr-shell-bytes',
      String(shellChunks.reduce((total, chunk) => total + chunk.byteLength, 0)),
    )
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of shellChunks) {
        if (chunk.byteLength !== 0) {
          controller.enqueue(chunk)
        }
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        controller.enqueue(value)
      }
      try {
        const resumed = await resume(postponed)
        if (resumed.body) {
          const resumedReader = resumed.body.getReader()
          for (;;) {
            const { done, value } = await resumedReader.read()
            if (done) {
              break
            }
            controller.enqueue(value)
          }
        }
      } catch (error) {
        // the shell is already out, so the page can only end short
        console.error('PPR resume error', error)
      }
      controller.close()
    },
  })
  return new Response(body, { status: shell.status, headers })
}
