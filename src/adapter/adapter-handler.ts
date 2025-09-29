import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

import { ComputeJsOutgoingMessage, toComputeResponse, toReqRes } from '@fastly/http-compute-js'
import type { Context } from '@netlify/functions'

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

type NextHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    waitUntil: (promise: Promise<unknown>) => void
  },
) => Promise<void | null>

export async function runNextHandler(
  request: Request,
  context: Context,
  nextHandler: NextHandler,
): Promise<Response> {
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

  nextHandler(req, res, {
    waitUntil: context.waitUntil,
  })
    .then(() => {
      console.log('handler done')
    })
    .catch((error) => {
      console.error('handler error', error)
    })
    .finally(() => {
      // Next.js relies on `close` event emitted by response to trigger running callback variant of `next/after`
      // however @fastly/http-compute-js never actually emits that event - so we have to emit it ourselves,
      // otherwise Next would never run the callback variant of `next/after`
      res.emit('close')
    })

  const response = await toComputeResponse(res)
  return response
}
