import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'

import {
  answerWithoutCompute,
  applyResolutionToResponse,
  deserializeResolution,
  isUnmatchedNextDataRequest,
  resolve,
  stripInternalRequestHeaders,
} from '../../adapter-runtime-shared/next-routing.js'
import type { ResolveRoutesResult } from '../../adapter-runtime-shared/next-routing.js'
import { PLUGIN_DIR } from '../constants.js'
import { getRequestMeta } from '../headers.js'
import {
  setFetchBeforeNextPatchedIt,
  setInMemoryCacheMaxSizeFromNextConfig,
} from '../storage/storage.cjs'

import {
  dispatch,
  isNotFoundPageRequest,
  isPlainNotFoundRequest,
  isStatusPageRequest,
  produceTarget,
  renderErrorPage,
} from './adapter/dispatch.js'
import { finalize } from './adapter/finalize.js'
import { basePath, manifest } from './adapter/manifest.js'
import { servePrerenderGroup } from './adapter/prerender-store.js'
import type { AdapterRequestContext, NextCallbacks, ProduceRequest } from './adapter/types.js'
import { NetlifyAdapterCacheHandler } from './cache-adapter.cjs'
import { getLogger } from './request-context.cjs'
import { getTracer, withActiveSpan } from './tracer.cjs'
import { configureFetchCacheHandler, configureUseCacheHandlers } from './use-cache-handler.js'

// Next's server loads .env files at startup, route modules don't. PLUGIN_DIR is the app dir in the
// handler where the .env files were copied to, and @next/env resolves to the app's copy shipped there.
// @next/env is CommonJS, so the named export is only there when cjs-module-lexer detects it
const nextEnv =
  // eslint-disable-next-line import/no-extraneous-dependencies, n/no-extraneous-import
  (await import('@next/env')) as typeof import('@next/env') & {
    default?: typeof import('@next/env')
  }
;(nextEnv.default ?? nextEnv).loadEnvConfig(PLUGIN_DIR, false)

// make use of global fetch before Next.js applies any patching
setFetchBeforeNextPatchedIt(globalThis.fetch)
// configure globals that Next.js make use of before we start importing any Next.js code
// as some globals are consumed at import time
// adapter mode needs a Next.js with CacheHandlerV2 (>=15.3.0-canary.13), see MIN_NEXT_VERSION
configureUseCacheHandlers()
// minimal mode only caches `FETCH` entries through the incremental cache. Same as Vercel: the
// handler is the global `FetchCache` (see configureUseCacheHandlers for why not a config path), so
// an app's own `cacheHandler` takes precedence.
configureFetchCacheHandler(NetlifyAdapterCacheHandler)
setInMemoryCacheMaxSizeFromNextConfig(manifest.config.cacheMaxMemorySize)

// Next.js checks globalThis.AsyncLocalStorage to decide whether to use real
// or fake (throwing) AsyncLocalStorage. Must be set before any Next.js code loads
// (the dynamic import() of route entrypoints happens at request time, after this).
if (!('AsyncLocalStorage' in globalThis)) {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.AsyncLocalStorage = AsyncLocalStorage
}

/**
 * `res.revalidate()`: Next hands over a path and the headers carrying the bypass token. Routing and
 * dispatch find the prerender group (the path may be dynamic or rewritten), then the prerender store
 * regenerates it on demand. Nothing is served, so there is nothing to finalize.
 */
async function revalidateOnDemand(
  request: Request,
  requestContext: AdapterRequestContext,
  nextCallbacks: NextCallbacks,
): Promise<void> {
  const headers = stripInternalRequestHeaders(new Headers(request.headers))
  const resolution = await resolve(
    { url: new URL(request.url), headers, requestBody: new ReadableStream() },
    manifest.routingConfig,
  )
  if (!resolution.resolvedPathname) {
    return
  }
  const target = dispatch(resolution.resolvedPathname, resolution, request, headers)
  if (target.kind !== 'output' || !target.prerender?.onDemand) {
    return
  }
  const { variant, group, onDemand } = target.prerender
  await servePrerenderGroup(
    variant,
    group,
    { request, requestContext, resolution, tracer: getTracer(), nextCallbacks },
    onDemand,
  )
}

/**
 * Next's mid-render callbacks for this request, passed to route modules via requestMeta: `render404`
 * renders our custom 404 page for `notFound: true` / `notFound()` instead of Next's bare fallback,
 * `revalidate` handles Pages Router `res.revalidate()` here instead of over the network.
 */
function createNextCallbacks(
  request: Request,
  requestContext: AdapterRequestContext,
): NextCallbacks {
  const tracer = getTracer()
  const nextCallbacks: NextCallbacks = {
    render404: async (req, res, _parsedUrl, setHeaders) => {
      // Next takes the page into its own response mid-render, so it is final here
      const response = await finalize(
        await renderErrorPage(404, { request, requestContext, tracer, nextCallbacks }),
        request,
      )
      if (!res.headersSent) {
        res.statusCode = 404
        for (const [name, value] of response.headers) {
          // the body is written as is, so the headers describing its bytes go with it (a static page
          // proxied from the CDN comes back compressed)
          if (
            name === 'content-type' ||
            name === 'content-encoding' ||
            (setHeaders && !['content-length', 'transfer-encoding'].includes(name))
          ) {
            res.setHeader(name, value)
          }
        }
      }
      res.end(Buffer.from(await response.arrayBuffer()))
    },
    revalidate: async ({ urlPath, headers }) => {
      const revalidateHeaders = new Headers()
      for (const [name, valueOrValues] of Object.entries(headers)) {
        for (const value of Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues]) {
          revalidateHeaders.append(name, value)
        }
      }
      const revalidateRequest = new Request(
        new URL(`${manifest.config.basePath}${urlPath}`, request.url),
        { headers: revalidateHeaders },
      )
      const revalidatePromise = revalidateOnDemand(revalidateRequest, requestContext, nextCallbacks)
      requestContext.trackBackgroundWork(revalidatePromise)
      await revalidatePromise.catch((revalidateError) => {
        console.error('Revalidation failed', revalidateError)
      })
    },
  }
  return nextCallbacks
}

export default async function ServerHandler(
  request: Request,
  requestContext: AdapterRequestContext,
) {
  const tracer = getTracer()
  const nextCallbacks = createNextCallbacks(request, requestContext)

  return await withActiveSpan(tracer, 'adapter route resolution', async (span) => {
    const url = new URL(request.url)

    let resolution: ResolveRoutesResult

    // Without the routing edge function in front (no middleware, or it isn't deployed) this is where
    // the request enters, so drop the headers Next's own tiers use to talk to each other, like
    // router-server does. Behind the edge function they are ours: middleware puts the cookies it set
    // in `x-middleware-set-cookie` for the render.
    const requestMeta = getRequestMeta(request)
    const serializedResolution = requestMeta?.routeResolution
    const requestHeaders = serializedResolution
      ? new Headers(request.headers)
      : stripInternalRequestHeaders(new Headers(request.headers))

    if (serializedResolution) {
      // Resolution was computed by the routing edge function — skip resolveRoutes
      resolution = deserializeResolution(serializedResolution)
    } else {
      // No edge function (standalone mode fallback, or edge function not deployed)
      try {
        resolution = await resolve(
          { url, headers: requestHeaders, requestBody: request.body ?? new ReadableStream() },
          manifest.routingConfig,
        )
      } catch (error) {
        console.error('route resolution error', error)
        getLogger().withError(error).error('route resolution error')
        return new Response('Internal Server Error', { status: 500 })
      }
    }

    const applyResolutionToThisResponse = applyResolutionToResponse.bind(null, {
      request,
      resolution,
      basePath,
    })
    // for what the function produced: routing's Cache-Control wins over Next's, as in `next start`
    const applyResolutionToProduced = applyResolutionToResponse.bind(null, {
      request,
      resolution,
      basePath,
      routingCacheControlWins: true,
    })

    const answered = await answerWithoutCompute(resolution, {
      request,
      basePath,
      outgoingRequest: () =>
        new Request(request.url, {
          method: request.method,
          headers: requestHeaders,
          body: request.body,
          // @ts-expect-error duplex is needed for streaming bodies
          duplex: 'half',
        }),
    })
    if (answered) {
      return answered
    }

    // Handle matched route
    if (resolution.resolvedPathname) {
      span?.setAttribute('matched.pathname', resolution.resolvedPathname)
      const target = dispatch(resolution.resolvedPathname, resolution, request, requestHeaders)
      span?.setAttributes({
        'matched.target': target.kind,
        'matched.output': target.kind === 'output' ? target.output.kind : undefined,
        'matched.router':
          target.kind === 'output' && target.output.kind === 'compute'
            ? target.output.output.router
            : undefined,
        'matched.prerender': target.kind === 'output' && Boolean(target.prerender),
      })
      if (target.kind === 'error') {
        span?.setAttribute('matched.noOutput', true)
        return finalize(
          await renderErrorPage(target.status, {
            request,
            requestContext,
            tracer,
            span,
            nextCallbacks,
          }),
          request,
          (response) => applyResolutionToProduced(response, target.status),
        )
      }
      if (target.kind === 'answer') {
        return applyResolutionToThisResponse(target.response, target.status)
      }

      // Next's route modules expect req.url to be the URL the client requested (that's req.url and
      // asPath, and config rewrites are re-applied from it), the rewrite result travels separately.
      // The routing edge function forwards the rewrite target as the URL though (so the CDN can cache
      // by it) and passes the requested URL in the private meta header.
      const publicUrl = requestMeta?.publicUrl ?? request.url

      // `x-nextjs-data` as routing decided it: set for data requests, never trusted from the client
      const handlerHeaders = new Headers(requestHeaders)
      if (resolution.invocation?.headers['x-nextjs-data']) {
        handlerHeaders.set('x-nextjs-data', '1')
      } else {
        handlerHeaders.delete('x-nextjs-data')
      }

      const handlerArgs: ProduceRequest = {
        request: new Request(publicUrl, {
          method: request.method,
          headers: handlerHeaders,
          body: request.body,
          // @ts-expect-error duplex is needed for streaming bodies
          duplex: 'half',
        }),
        requestContext,
        resolution,
        tracer,
        span,
        nextCallbacks,
      }

      const produced = await produceTarget(target, handlerArgs)

      const isNotFoundPage = isNotFoundPageRequest(request, resolution.resolvedPathname)
      const status = isNotFoundPage
        ? 404
        : isStatusPageRequest(request, resolution.resolvedPathname, 500)
          ? 500
          : resolution.status
      // Next's server responds 404 to a direct request for the 404 page, served like any error page
      // (CACHE_404_PAGE cache-control handling keys off the status)
      return finalize(
        isNotFoundPage ? { kind: 'error', status: 404, produced } : produced,
        handlerArgs.request,
        (routed) => applyResolutionToProduced(routed, status),
      )
    }

    // the edge function answers this itself; behind it `url` is the rewrite target
    if (
      isUnmatchedNextDataRequest(new URL(requestMeta?.publicUrl ?? request.url), resolution, {
        basePath: manifest.config.basePath || '',
        buildId: manifest.buildId,
        middlewareMatchers: manifest.routingConfig.routes.middlewareMatchers,
      })
    ) {
      return applyResolutionToThisResponse(Response.json({}))
    }

    // No match found — 404
    if (isPlainNotFoundRequest(url)) {
      return applyResolutionToThisResponse(
        new Response('Not Found', {
          status: 404,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
          },
        }),
        404,
      )
    }
    // TODO(adapter): this can be cached forever because it will never match any routes
    // but we would need to collect routing rules that were involved and inspect them as rules might rely on headers or other request properties,
    // which would require setting correct netlify-vary header.
    return finalize(
      await renderErrorPage(404, { request, requestContext, tracer, span, nextCallbacks }),
      request,
      (response) => applyResolutionToProduced(response, 404),
    )
  })
}
