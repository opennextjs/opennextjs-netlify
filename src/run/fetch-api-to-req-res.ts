import type { OutgoingHttpHeaders } from 'node:http'

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
  })

  disableFaultyTransferEncodingHandling(res as unknown as ComputeJsOutgoingMessage)

  return { req, res }
}
