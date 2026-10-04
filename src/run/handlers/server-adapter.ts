import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'

import type { RequestMeta } from 'next-with-adapters/dist/server/request-meta.js'

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
import { getRequestMeta, setVaryHeaders } from '../headers.js'
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
import { cacheOf, finalize, setCacheControl } from './adapter/finalize.js'
import { configureInvoke } from './adapter/invoke.js'
import { basePath, manifest } from './adapter/manifest.js'
import type { AdapterRequestContext, ProduceRequest } from './adapter/types.js'
import { NetlifyAdapterCacheHandler } from './cache-adapter.cjs'
import { getLogger, getRequestContext } from './request-context.cjs'
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

// passed via requestMeta so Next.js renders our custom 404 page for `notFound: true` / `notFound()`
// instead of its bare "This page could not be found" fallback
const render404: NonNullable<RequestMeta['render404']> = async (
  req,
  res,
  _parsedUrl,
  setHeaders,
) => {
  const requestContext: AdapterRequestContext | undefined = getRequestContext()
  if (!requestContext?.originalRequest) {
    throw new Error('render404 called outside of request context')
  }
  // Next calls this mid-render and takes the page into its own response, so it is final here
  const response = await finalize(
    await renderErrorPage(404, {
      request: requestContext.originalRequest,
      requestContext,
      tracer: getTracer(),
    }),
    requestContext.originalRequest,
  )
  if (!res.headersSent) {
    res.statusCode = 404
    for (const [name, value] of response.headers) {
      if (
        name === 'content-type' ||
        (setHeaders && !['content-length', 'transfer-encoding'].includes(name))
      ) {
        res.setHeader(name, value)
      }
    }
  }
  res.end(Buffer.from(await response.arrayBuffer()))
}

// passed via requestMeta so pages router `res.revalidate()` goes through this handler instead of network
const revalidate: NonNullable<RequestMeta['revalidate']> = async (args) => {
  const { urlPath, headers: revalidateHeaders } = args
  const requestContext: AdapterRequestContext | undefined = getRequestContext()
  if (!requestContext) {
    throw new Error('revalidate called outside of request context')
  }

  if (!requestContext.originalRequest) {
    throw new Error('original request not set in request context')
  }

  if (!requestContext.originalContext) {
    throw new Error('original context not set in request context')
  }

  const normalizeRevalidateHeaders = new Headers()
  for (const [headerName, headerValueOrValues] of Object.entries(revalidateHeaders)) {
    const headerValues = Array.isArray(headerValueOrValues)
      ? headerValueOrValues
      : [headerValueOrValues]
    for (const headerValue of headerValues) {
      normalizeRevalidateHeaders.append(headerName, headerValue)
    }
  }

  const revalidateRequest = new Request(
    new URL(`${manifest.config.basePath}${urlPath}`, requestContext.originalRequest.url),
    {
      headers: normalizeRevalidateHeaders,
    },
  )

  const revalidatePromise = ServerHandler(revalidateRequest, requestContext)
  requestContext.trackBackgroundWork(revalidatePromise)
  return revalidatePromise
    .catch((revalidateError) => {
      console.error('Revalidation failed', revalidateError)
    })
    .then(() => {
      // no-op
    })
}

configureInvoke({ render404, revalidate, renderErrorPage })

export default async function ServerHandler(
  request: Request,
  requestContext: AdapterRequestContext,
) {
  const tracer = getTracer()

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
      if (target.kind === 'error') {
        span?.setAttribute('matched.noOutput', true)
        return finalize(
          await renderErrorPage(target.status, { request, requestContext, tracer, span }),
          request,
          (response) => applyResolutionToThisResponse(response, target.status),
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
      }

      const produced = await produceTarget(target, handlerArgs)

      const isNotFoundPage = isNotFoundPageRequest(request, resolution.resolvedPathname)
      const status = isNotFoundPage
        ? 404
        : isStatusPageRequest(request, resolution.resolvedPathname, 500)
          ? 500
          : resolution.status
      const response = await finalize(produced, handlerArgs.request, (routed) =>
        applyResolutionToThisResponse(routed, status),
      )
      if (isNotFoundPage) {
        // Next's server responds 404 here, and CACHE_404_PAGE cache-control handling keys off that
        setCacheControl(response, request, cacheOf(produced)?.revalidate)
        setVaryHeaders(
          response.headers,
          request,
          manifest.config as Parameters<typeof setVaryHeaders>[2],
        )
      }
      return response
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
      await renderErrorPage(404, { request, requestContext, tracer, span }),
      request,
      (response) => applyResolutionToThisResponse(response, 404),
    )
  })
}
