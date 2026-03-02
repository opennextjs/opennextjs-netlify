import type { Context } from '@netlify/functions'
import type { Span } from '@netlify/otel/opentelemetry'
import type { WorkerRequestHandler } from 'next/dist/server/lib/types.js'

import { augmentNextResponse } from '../augment-next-response.js'
import { getRunConfig, setRunConfig } from '../config.js'
import { toComputeResponse, toReqRes } from '../fetch-api-to-req-res.js'
import {
  adjustDateHeader,
  setCacheControlHeaders,
  setCacheStatusHeader,
  setCacheTagsHeaders,
  setVaryHeaders,
} from '../headers.js'
import { setFetchBeforeNextPatchedIt } from '../storage/storage.cjs'

import { getLogger, type RequestContext } from './request-context.cjs'
import { getTracer, recordWarning, withActiveSpan } from './tracer.cjs'
import { configureUseCacheHandlers } from './use-cache-handler.js'
import { setupWaitUntil } from './wait-until.cjs'
// make use of global fetch before Next.js applies any patching
setFetchBeforeNextPatchedIt(globalThis.fetch)
// configure globals that Next.js make use of before we start importing any Next.js code
// as some globals are consumed at import time
const { nextConfig: initialNextConfig, enableUseCacheHandler } = await getRunConfig()
if (enableUseCacheHandler) {
  configureUseCacheHandlers()
}
const nextConfig = setRunConfig(initialNextConfig)
setupWaitUntil()

const nextImportPromise = import('../next.cjs')

let nextHandler: WorkerRequestHandler

export default async (
  request: Request,
  _context: Context,
  topLevelSpan: Span | undefined,
  requestContext: RequestContext,
) => {
  const tracer = getTracer()

  if (!nextHandler) {
    await withActiveSpan(tracer, 'initialize next server', async () => {
      const { getMockedRequestHandler } = await nextImportPromise
      const url = new URL(request.url)

      nextHandler = await getMockedRequestHandler(nextConfig, {
        port: Number(url.port) || 443,
        hostname: url.hostname,
        dir: process.cwd(),
        isDev: false,
      })
    })
  }

  return await withActiveSpan(tracer, 'generate response', async (span) => {
    const { req, res } = toReqRes(request)

    const resProxy = augmentNextResponse(res, requestContext)

    // We don't await this here, because it won't resolve until the response is finished.
    const nextHandlerPromise = nextHandler(req, resProxy).catch((error) => {
      getLogger().withError(error).error('next handler error')
      console.error(error)
      resProxy.statusCode = 500
      span?.setAttribute('http.status_code', 500)
      resProxy.end('Internal Server Error')
    })

    // Contrary to the docs, this resolves when the headers are available, not when the stream closes.
    // See https://github.com/fastly/http-compute-js/blob/main/src/http-compute-js/http-server.ts#L168-L173
    const response = await toComputeResponse(resProxy)

    if (requestContext.responseCacheKey) {
      topLevelSpan?.setAttribute('responseCacheKey', requestContext.responseCacheKey)
    }

    const nextCache = response.headers.get('x-nextjs-cache')
    const isServedFromNextCache = nextCache === 'HIT' || nextCache === 'STALE'

    if (isServedFromNextCache) {
      await adjustDateHeader({
        headers: response.headers,
        request,
        span,
        requestContext,
      })
    }

    setCacheControlHeaders(response, request, requestContext)
    setCacheTagsHeaders(response.headers, requestContext)
    setVaryHeaders(response.headers, request, nextConfig)
    setCacheStatusHeader(response.headers, nextCache)

    const netlifyVary = response.headers.get('netlify-vary') ?? undefined
    const netlifyCdnCacheControl = response.headers.get('netlify-cdn-cache-control') ?? undefined
    topLevelSpan?.setAttributes({
      'x-nextjs-cache': nextCache ?? undefined,
      isServedFromNextCache,
      netlifyVary,
      netlifyCdnCacheControl,
    })

    if (requestContext.isCacheableAppPage && response.status !== 304) {
      const isRSCRequest = request.headers.get('rsc') === '1'
      const contentType = response.headers.get('content-type') ?? undefined

      const isExpectedContentType =
        ((isRSCRequest && contentType?.includes('text/x-component')) ||
          (!isRSCRequest && contentType?.includes('text/html'))) ??
        false

      topLevelSpan?.setAttributes({
        isRSCRequest,
        isCacheableAppPage: true,
        contentType,
        isExpectedContentType,
      })

      if (!isExpectedContentType) {
        recordWarning(
          new Error(
            `Unexpected content type was produced for App Router page response (isRSCRequest: ${isRSCRequest}, contentType: ${contentType})`,
          ),
          topLevelSpan,
        )
      }
    }

    async function waitForBackgroundWork() {
      // it's important to keep the stream open until the next handler has finished
      await nextHandlerPromise

      // Next.js relies on `close` event emitted by response to trigger running callback variant of `next/after`
      // however @fastly/http-compute-js never actually emits that event - so we have to emit it ourselves,
      // otherwise Next would never run the callback variant of `next/after`
      res.emit('close')

      // We have to keep response stream open until tracked background promises that are don't use `context.waitUntil`
      // are resolved. If `context.waitUntil` is available, `requestContext.backgroundWorkPromise` will be empty
      // resolved promised and so awaiting it is no-op
      await requestContext.backgroundWorkPromise
    }

    const keepOpenUntilNextFullyRendered = new TransformStream({
      async flush() {
        await waitForBackgroundWork()
      },
    })

    if (!response.body) {
      await waitForBackgroundWork()
    }

    return new Response(response.body?.pipeThrough(keepOpenUntilNextFullyRendered), response)
  })
}
