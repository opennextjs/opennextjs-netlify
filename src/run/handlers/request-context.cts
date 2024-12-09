import { AsyncLocalStorage } from 'node:async_hooks'

import type { Context } from '@netlify/functions'
import { LogLevel, systemLogger } from '@netlify/functions/internal'

import type { NetlifyCachedRouteValue } from '../../shared/cache-types.cjs'

type SystemLogger = typeof systemLogger

// TODO: remove once public types are updated
export interface FutureContext extends Context {
  waitUntil?: (promise: Promise<unknown>) => void
}

export type RequestContext = {
  captureServerTiming: boolean
  responseCacheGetLastModified?: number
  responseCacheKey?: string
  responseCacheTags?: string[]
  usedFsReadForNonFallback?: boolean
  didPagesRouterOnDemandRevalidate?: boolean
  serverTiming?: string
  routeHandlerRevalidate?: NetlifyCachedRouteValue['revalidate']
  /**
   * Track promise running in the background and need to be waited for.
   * Uses `context.waitUntil` if available, otherwise stores promises to
   * await on.
   */
  trackBackgroundWork: (promise: Promise<unknown>) => void
  /**
   * Promise that need to be executed even if response was already sent.
   * If `context.waitUntil` is available this promise will be always resolved
   * because background work tracking was offloaded to `context.waitUntil`.
   */
  backgroundWorkPromise: Promise<unknown>
  logger: SystemLogger
}

type RequestContextAsyncLocalStorage = AsyncLocalStorage<RequestContext>

export function createRequestContext(request?: Request, context?: FutureContext): RequestContext {
  const backgroundWorkPromises: Promise<unknown>[] = []

  return {
    captureServerTiming: request?.headers.has('x-next-debug-logging') ?? false,
    trackBackgroundWork: (promise) => {
      if (context?.waitUntil) {
        context.waitUntil(promise)
      } else {
        backgroundWorkPromises.push(promise)
      }
    },
    get backgroundWorkPromise() {
      return Promise.allSettled(backgroundWorkPromises)
    },
    logger: systemLogger.withLogLevel(
      request?.headers.has('x-nf-debug-logging') || request?.headers.has('x-next-debug-logging')
        ? LogLevel.Debug
        : LogLevel.Log,
    ),
  }
}

const REQUEST_CONTEXT_GLOBAL_KEY = Symbol.for('nf-request-context-async-local-storage')
let requestContextAsyncLocalStorage: RequestContextAsyncLocalStorage | undefined
function getRequestContextAsyncLocalStorage() {
  if (requestContextAsyncLocalStorage) {
    return requestContextAsyncLocalStorage
  }
  // for cases when there is multiple "copies" of this module, we can't just init
  // AsyncLocalStorage in the module scope, because it will be different for each
  // copy - so first time an instance of this module is used, we store AsyncLocalStorage
  // in global scope and reuse it for all subsequent calls
  const extendedGlobalThis = globalThis as typeof globalThis & {
    [REQUEST_CONTEXT_GLOBAL_KEY]?: RequestContextAsyncLocalStorage
  }
  if (extendedGlobalThis[REQUEST_CONTEXT_GLOBAL_KEY]) {
    return extendedGlobalThis[REQUEST_CONTEXT_GLOBAL_KEY]
  }

  const storage = new AsyncLocalStorage<RequestContext>()
  // store for future use of this instance of module
  requestContextAsyncLocalStorage = storage
  // store for future use of copy of this module
  extendedGlobalThis[REQUEST_CONTEXT_GLOBAL_KEY] = storage
  return storage
}

export const getRequestContext = () => getRequestContextAsyncLocalStorage().getStore()

export function runWithRequestContext<T>(requestContext: RequestContext, fn: () => T): T {
  return getRequestContextAsyncLocalStorage().run(requestContext, fn)
}

export function getLogger(): SystemLogger {
  return getRequestContext()?.logger ?? systemLogger
}
