import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ComputeJsOutgoingMessage, toReqRes as toInitialReqRes } from '@fastly/http-compute-js'

export { toComputeResponse } from '@fastly/http-compute-js'

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

/**
 * Prevent .appendHeader calls for location header to add duplicate values
 */
const avoidDoubleLocationHeader = (res: ComputeJsOutgoingMessage) => {
  const originalAppendHeader = res.appendHeader
  res.appendHeader = function appendHeader(
    ...args: Parameters<ComputeJsOutgoingMessage['appendHeader']>
  ) {
    if (typeof args[0] === 'string' && (args[0] === 'location' || args[0] === 'Location')) {
      let existing = res.getHeader('location')
      if (typeof existing !== 'undefined') {
        if (!Array.isArray(existing)) {
          existing = [String(existing)]
        }
        if (existing.includes(String(args[1]))) {
          // if we already have that location header - bail early
          // appendHeader should return the target for chaining
          return res
        }
      }
    }
    return originalAppendHeader.apply(this, args)
  }
}

export const toReqRes = (request: Request) => {
  const { req, res } = toInitialReqRes(request)

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
    set(value) {
      if (value === null) {
        // ignore Object.destroyer (node:internal/streams/destroy:333:19) setting null
        return
      }
      throw new Error('Unsupported attempt to set socket on request')
    },
  })

  disableFaultyTransferEncodingHandling(res as unknown as ComputeJsOutgoingMessage)
  avoidDoubleLocationHeader(res as unknown as ComputeJsOutgoingMessage)

  return { req, res }
}

/**
 * A Netlify Server request as a fetch `Request`, for routing. Its body is only read when something
 * reads it: Next's render gets `req` itself.
 */
export const toFetchRequest = (req: IncomingMessage, url: URL) => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    for (const item of [value ?? []].flat()) {
      headers.append(name, item)
    }
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? null
      : new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              reader ??= (Readable.toWeb(req) as ReadableStream<Uint8Array>).getReader()
              const { done, value } = await reader.read()
              if (done) {
                controller.close()
              } else {
                controller.enqueue(value)
              }
            },
            cancel: (reason) => reader?.cancel(reason),
          },
          // otherwise the first pull happens right away
          { highWaterMark: 0 },
        )
  // @ts-expect-error duplex is needed for streaming bodies
  return new Request(url, { method: req.method, headers, body, duplex: 'half' })
}

export const writeResponse = async (response: Response, res: ServerResponse) => {
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') {
      res.setHeader(name, value)
    }
  }
  const cookies = response.headers.getSetCookie()
  if (cookies.length !== 0) {
    res.setHeader('set-cookie', cookies)
  }
  res.writeHead(response.status)
  if (response.body) {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res)
  } else {
    res.end()
  }
}
