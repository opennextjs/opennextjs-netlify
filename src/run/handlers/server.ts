import type { OutgoingHttpHeaders } from 'http'

import { ComputeJsOutgoingMessage, toComputeResponse, toReqRes } from '@fastly/http-compute-js'
import { Context } from '@netlify/functions'
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

const nextImportPromise = import('../next.cjs')

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

// TODO: remove once https://github.com/netlify/serverless-functions-api/pull/219
// is released and public types are updated
interface FutureContext extends Context {
  waitUntil?: (promise: Promise<unknown>) => void
}

export default async (request: Request, context: FutureContext) => {
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

    setCacheControlHeaders(response, request, requestContext)
    setCacheTagsHeaders(response.headers, requestContext)
    setVaryHeaders(response.headers, request, nextConfig)
    setCacheStatusHeader(response.headers)

    // Temporary workaround for an issue where sending a response with an empty
    // body causes an unhandled error. This doesn't catch everything, but redirects are the
    // most common case of sending empty bodies. We can't check it directly because these are streams.
    // The side effect is that responses which do contain data will not be streamed to the client,
    // but that's fine for redirects.
    // TODO: Remove once a fix has been rolled out.
    if ((response.status > 300 && response.status < 400) || response.status >= 500) {
      const body = await response.text()
      return new Response(body || null, response)
    }

    if (context.waitUntil) {
      context.waitUntil(requestContext.backgroundWorkPromise)
    }

    const keepOpenUntilNextFullyRendered = new TransformStream({
      async flush() {
        // it's important to keep the stream open until the next handler has finished
        await nextHandlerPromise
        if (!context.waitUntil) {
          // if waitUntil is not available, we have to keep response stream open until background promises are resolved
          // to ensure that all background work executes
          await requestContext.backgroundWorkPromise
        }
      },
    })

    return new Response(response.body?.pipeThrough(keepOpenUntilNextFullyRendered), response)
  })
}
