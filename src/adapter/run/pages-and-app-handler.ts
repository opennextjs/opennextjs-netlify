import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { join } from 'node:path/posix'
import { fileURLToPath } from 'node:url'

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

const getHeaderValueArray = (header: string): string[] => {
  return header
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

const omitHeaderValues = (header: string, values: string[]): string => {
  const headerValues = getHeaderValueArray(header)
  const filteredValues = headerValues.filter(
    (value) => !values.some((val) => value.startsWith(val)),
  )
  return filteredValues.join(', ')
}

/**
 * https://httpwg.org/specs/rfc9211.html
 *
 * We get HIT, MISS, STALE statuses from Next cache.
 * We will ignore other statuses and will not set Cache-Status header in those cases.
 */
const NEXT_CACHE_TO_CACHE_STATUS: Record<string, string> = {
  HIT: `hit`,
  MISS: `fwd=miss`,
  STALE: `hit; fwd=stale`,
}

const FUNCTION_ROOT = fileURLToPath(new URL('.', import.meta.url))
export const FUNCTION_ROOT_DIR = join(FUNCTION_ROOT, '..', '..', '..', '..')
if (process.cwd() !== FUNCTION_ROOT_DIR) {
  // setting CWD only needed for `ntl serve` as otherwise CWD is set to root of the project
  // when deployed CWD is correct
  // TODO(pieh): test with monorepo if this will work there as well, or cwd will need to have packagePath appended
  process.cwd = () => FUNCTION_ROOT_DIR
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
  console.log('Handling request', {
    url: request.url,
    isDataRequest: request.headers.get('x-nextjs-data'),
  })

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

  {
    // move cache-control to cdn-cache-control
    const cacheControl = response.headers.get('cache-control')
    if (
      cacheControl &&
      ['GET', 'HEAD'].includes(request.method) &&
      !response.headers.has('cdn-cache-control') &&
      !response.headers.has('netlify-cdn-cache-control')
    ) {
      // handle CDN Cache Control on ISR and App Router page responses
      const browserCacheControl = omitHeaderValues(cacheControl, [
        's-maxage',
        'stale-while-revalidate',
      ])
      const cdnCacheControl =
        // if we are serving already stale response, instruct edge to not attempt to cache that response
        response.headers.get('x-nextjs-cache') === 'STALE'
          ? 'public, max-age=0, must-revalidate, durable'
          : [
              ...getHeaderValueArray(cacheControl).map((value) =>
                value === 'stale-while-revalidate' ? 'stale-while-revalidate=31536000' : value,
              ),
              'durable',
            ].join(', ')

      response.headers.set(
        'cache-control',
        browserCacheControl || 'public, max-age=0, must-revalidate',
      )
      // response.headers.set('netlify-cdn-cache-control', cdnCacheControl)
    }
  }

  {
    // set Cache-Status header based on Next.js cache status
    const nextCache = response.headers.get('x-nextjs-cache')
    if (nextCache) {
      // eslint-disable-next-line unicorn/no-lonely-if
      if (nextCache in NEXT_CACHE_TO_CACHE_STATUS) {
        response.headers.set('cache-status', NEXT_CACHE_TO_CACHE_STATUS[nextCache])
      }
      // response.headers.delete('x-nextjs-cache')
    }
  }

  return response
}
