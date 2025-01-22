import type { OutgoingHttpHeaders } from 'http'

import { ComputeJsOutgoingMessage, toComputeResponse, toReqRes } from '@fastly/http-compute-js'
import type { NextConfigComplete } from 'next/dist/server/config-shared.js'
import type { WorkerRequestHandler } from 'next/dist/server/lib/types.js'

import {
  adjustDateHeader,
  setCacheControlHeaders,
  setCacheStatusHeader,
  setCacheTagsHeaders,
  setVaryHeaders,
} from '../headers.js'
import { nextResponseProxy } from '../revalidate.js'

import { createRequestContext, getLogger, getRequestContext } from './request-context.cjs'
import { getTracer } from './tracer.cjs'
import { setupWaitUntil } from './wait-until.cjs'

const nextImportPromise = import('../next.cjs')

setupWaitUntil()

let nextHandler: WorkerRequestHandler, nextConfig: NextConfigComplete

/**
 * When Next.js proxies requests externally, it writes the response back as-is.
 * In some cases, this includes Transfer-Encoding: chunked.
 * This triggers behaviour in @fastly/http-compute-js to separate chunks with chunk delimiters, which is not what we want at this level.
 * We want Lambda to control the behaviour around chunking, not this.
 * This workaround removes the Transfer-Encoding header, which makes the library send the response as-is.
 */
const disableFaultyTransferEncodingHandling = (res: ComputeJsOutgoingMessage) => {
  const originalStoreHeader = res._storeHeader
  res._storeHeader = function _storeHeader(firstLine, headers) {
    if (headers) {
      if (Array.isArray(headers)) {
        // eslint-disable-next-line no-param-reassign
        headers = headers.filter(([header]) => header.toLowerCase() !== 'transfer-encoding')
      } else {
        delete (headers as OutgoingHttpHeaders)['transfer-encoding']
      }
    }

    return originalStoreHeader.call(this, firstLine, headers)
  }
}

export default async (request: Request) => {
  const tracer = getTracer()

  if (!nextHandler) {
    await tracer.withActiveSpan('initialize next server', async () => {
      // set the server config
      const { getRunConfig, setRunConfig } = await import('../config.js')
      nextConfig = await getRunConfig()
      setRunConfig(nextConfig)

      const { getMockedRequestHandler } = await nextImportPromise
      const url = new URL(request.url)

      nextHandler = await getMockedRequestHandler({
        port: Number(url.port) || 443,
        hostname: url.hostname,
        dir: process.cwd(),
        isDev: false,
      })
    })
  }

  return await tracer.withActiveSpan('generate response', async (span) => {
    const { req, res } = toReqRes(request)

    // Work around a bug in http-proxy in next@<14.0.2
    Object.defineProperty(req, 'connection', {
      get() {
        return {}
      },
    })
    Object.defineProperty(req, 'socket', {
      get() {
        return {}
      },
    })

    disableFaultyTransferEncodingHandling(res as unknown as ComputeJsOutgoingMessage)

    const requestContext = getRequestContext() ?? createRequestContext()

    const resProxy = nextResponseProxy(res, requestContext)

    // We don't await this here, because it won't resolve until the response is finished.
    const nextHandlerPromise = nextHandler(req, resProxy).catch((error) => {
      getLogger().withError(error).error('next handler error')
      console.error(error)
      resProxy.statusCode = 500
      span.setAttribute('http.status_code', 500)
      resProxy.end('Internal Server Error')
    })

    // Contrary to the docs, this resolves when the headers are available, not when the stream closes.
    // See https://github.com/fastly/http-compute-js/blob/main/src/http-compute-js/http-server.ts#L168-L173
    const response = await toComputeResponse(resProxy)

    if (requestContext.responseCacheKey) {
      span.setAttribute('responseCacheKey', requestContext.responseCacheKey)
    }

    await adjustDateHeader({ headers: response.headers, request, span, tracer, requestContext })

    setCacheControlHeaders(response, request, requestContext, nextConfig)
    setCacheTagsHeaders(response.headers, requestContext)
    setVaryHeaders(response.headers, request, nextConfig)
    setCacheStatusHeader(response.headers)

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
