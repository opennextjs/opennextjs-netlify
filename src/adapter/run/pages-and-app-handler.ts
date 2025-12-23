import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { join } from 'node:path/posix'
import { fileURLToPath } from 'node:url'

import { ComputeJsOutgoingMessage, toComputeResponse, toReqRes } from '@fastly/http-compute-js'
import type { Context } from '@netlify/functions'
import type {
  RevalidateFn,
  RouterServerContext,
} from 'next-with-adapters/dist/server/lib/router-utils/router-server-context.js'
import {
  NEXT_REQUEST_META,
  type NextIncomingMessage,
  type RequestMeta,
} from 'next-with-adapters/dist/server/request-meta.js'

import { getTracer, withActiveSpan } from '../../run/handlers/tracer.cjs'
import type { NetlifyAdapterContext } from '../build/types.js'

import { generateAdapterCacheControl } from './headers.js'
import {
  generateIsrCacheKey,
  matchIsrDefinitionFromIsrGroup,
  matchIsrGroupFromOutputs,
  requestToIsrRequest,
  responseToCacheEntry,
  storeIsrGroupUpdate,
} from './isr.js'

globalThis.AsyncLocalStorage = AsyncLocalStorage

const RouterServerContextSymbol = Symbol.for('@next/router-server-methods')

const globalThisWithRouterServerContext = globalThis as typeof globalThis & {
  [RouterServerContextSymbol]?: RouterServerContext
}

if (!globalThisWithRouterServerContext[RouterServerContextSymbol]) {
  globalThisWithRouterServerContext[RouterServerContextSymbol] = {}
}

const revalidate: RevalidateFn = (config) => {
  console.log('revalidate called with args:', config)
  return Promise.resolve()
}

globalThisWithRouterServerContext[RouterServerContextSymbol]['.'] = {
  revalidate,
}

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

function addRequestMeta<K extends keyof RequestMeta>(
  req: IncomingMessage,
  key: K,
  value: RequestMeta[K],
) {
  const typedReq = req as NextIncomingMessage
  const meta = typedReq[NEXT_REQUEST_META] || {}
  meta[key] = value
  typedReq[NEXT_REQUEST_META] = meta
  return meta
}

async function runNextHandler(
  request: Request,
  context: Context,
  nextHandler: NextHandler,
  onEnd?: () => Promise<void>,
) {
  console.log('Handling request', request.url)

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

  const postponed = request.headers.get('x-ppr-resume')
  if (postponed) {
    console.log('setting postponed meta', postponed)
    addRequestMeta(req, 'postponed', postponed)
    request.headers.delete('x-ppr-resume')
  }

  addRequestMeta(req, 'relativeProjectDir', '.')

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

      // run any of our own post handling work
      if (onEnd) {
        context.waitUntil(onEnd())
      }
    })

  const response = await toComputeResponse(res)

  if (['GET', 'HEAD'].includes(request.method)) {
    generateAdapterCacheControl(response.headers)
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

export async function runHandler(
  request: Request,
  context: Context,
  outputs: Pick<NetlifyAdapterContext['preparedOutputs'], 'endpoints' | 'isrGroups'>,
  require: NodeJS.Require,
): Promise<Response> {
  const tracer = getTracer()

  return withActiveSpan(tracer, 'Adapter Handler', async (span) => {
    const url = new URL(request.url)

    console.log('Incoming request', request.url)
    span?.setAttribute('next.match.pathname', url.pathname)

    let matchType = 'miss'
    let matchOutput: string | undefined

    const endpoint = outputs.endpoints[url.pathname]

    if (endpoint) {
      matchType = endpoint.type
      matchOutput = endpoint.id
    }

    span?.setAttributes({
      'next.match.pathname': url.pathname,
      'next.match.type': matchType,
      'next.match.output': matchOutput,
    })

    if (!endpoint) {
      span?.setAttribute(
        'next.unexpected',
        'We should not execute handler without matching endpoint',
      )
      return new Response('Not Found', { status: 404 })
    }

    // eslint-disable-next-line import/no-dynamic-require
    const mod = await require(`./${endpoint.entry}`)
    const nextHandler: NextHandler = mod.handler

    if (typeof nextHandler !== 'function') {
      span?.setAttribute('next.unexpected', 'nextHandler is not a function')
    }

    if (endpoint.type === 'isr') {
      const isrDefs = matchIsrGroupFromOutputs(request, outputs)

      if (!isrDefs) {
        span?.setAttribute('next.unexpected', "can't find ISR group for pathname")
        throw new Error("can't find ISR group for pathname")
      }

      const isrDef = matchIsrDefinitionFromIsrGroup(request, isrDefs)

      if (!isrDef) {
        span?.setAttribute('next.unexpected', "can't find ISR definition for pathname")
        throw new Error("can't find ISR definition for pathname")
      }

      // const handlerRequest = new Request(isrUrl, request)
      const isrRequest = requestToIsrRequest(request, isrDef)

      let resolveInitialPromiseToStore: (response: Response) => void = () => {
        // no-op
      }
      const promise = new Promise<Response>((resolve) => {
        resolveInitialPromiseToStore = resolve
      })

      const response = await runNextHandler(isrRequest, context, nextHandler, async () => {
        // first let's make sure we have current response ready
        const isrResponseToStore = await promise

        const groupUpdate = {
          [generateIsrCacheKey(isrRequest, isrDef)]: await responseToCacheEntry(isrResponseToStore),
        }

        console.log('handle remaining ISR work in background')

        await Promise.all(
          isrDefs.map(async (def) => {
            if (def === isrDef) {
              // we already did the current on
              return
            }

            const newUrl = new URL(isrRequest.url)
            newUrl.pathname = def.pathname

            const newRequest = new Request(newUrl, isrRequest)
            const newResponse = await runNextHandler(newRequest, context, nextHandler)

            const cacheKey = generateIsrCacheKey(newRequest, def)
            groupUpdate[cacheKey] = await responseToCacheEntry(newResponse)
          }),
        )

        console.log('we now should have all responses for the group', groupUpdate)
        await storeIsrGroupUpdate(groupUpdate)
      })

      if (!response.body) {
        throw new Error('ISR response has no body')
      }

      const [body1, body2] = response.body.tee()
      const returnedResponse = new Response(body1, response)
      const isrResponseToStore = new Response(body2, response)

      resolveInitialPromiseToStore(isrResponseToStore)

      return returnedResponse
    }

    return await runNextHandler(request, context, nextHandler)
  })
}
