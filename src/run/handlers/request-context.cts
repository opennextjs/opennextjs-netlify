import { AsyncLocalStorage } from 'node:async_hooks'

import type { Context } from '@netlify/functions'
import { LogLevel, systemLogger } from '@netlify/functions/internal'

import type { NetlifyCachedRouteValue } from '../../shared/cache-types.cjs'

type SystemLogger = typeof systemLogger

export type RequestContext = {
  /**
   * Determine if this request is for CDN SWR background revalidation
   */
  isBackgroundRevalidation: boolean
  captureServerTiming: boolean
  responseCacheGetLastModified?: number
  responseCacheKey?: string
  responseCacheTags?: string[]
  usedFsReadForNonFallback?: boolean
  didPagesRouterOnDemandRevalidate?: boolean
  serverTiming?: string
  routeHandlerRevalidate?: NetlifyCachedRouteValue['revalidate']
  pageHandlerRevalidate?: NetlifyCachedRouteValue['revalidate']
  ongoingRevalidations?: Map<string, Promise<void>>
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
  requestID: string
  isCacheableAppPage?: boolean

  originalRequest?: Request
  originalContext?: Context
}

type RequestContextAsyncLocalStorage = AsyncLocalStorage<RequestContext>
const REQUEST_CONTEXT_GLOBAL_KEY = Symbol.for('nf-request-context-async-local-storage')
const REQUEST_COUNTER_KEY = Symbol.for('nf-request-counter')
const extendedGlobalThis = globalThis as typeof globalThis & {
  [REQUEST_CONTEXT_GLOBAL_KEY]?: RequestContextAsyncLocalStorage
  [REQUEST_COUNTER_KEY]?: number
}

function getFallbackRequestID() {
  const requestNumber = extendedGlobalThis[REQUEST_COUNTER_KEY] ?? 0
  extendedGlobalThis[REQUEST_COUNTER_KEY] = requestNumber + 1
  return `#${requestNumber}`
}

export function createRequestContext(request?: Request, context?: Context): RequestContext {
  const backgroundWorkPromises: Promise<unknown>[] = []

  const isDebugRequest =
    request?.headers.has('x-nf-debug-logging') || request?.headers.has('x-next-debug-logging')

  const logger = systemLogger
    .withLogLevel(isDebugRequest ? LogLevel.Debug : LogLevel.Log)
    .withFields({
      request_id: context?.requestId,
      site_id: context?.site?.id,
      deploy_id: context?.deploy?.id,
      url: request?.url,
    })

  const isBackgroundRevalidation =
    request?.headers.get('netlify-invocation-source') === 'background-revalidation'

  if (isBackgroundRevalidation) {
    logger.debug('[NetlifyNextRuntime] Background revalidation request')
  }

  return {
    isBackgroundRevalidation,
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
    logger,
    requestID: request?.headers.get('x-nf-request-id') ?? getFallbackRequestID(),
    originalRequest: request,
    originalContext: context,
  }
}

let requestContextAsyncLocalStorage: RequestContextAsyncLocalStorage | undefined
function getRequestContextAsyncLocalStorage() {
  if (requestContextAsyncLocalStorage) {
    return requestContextAsyncLocalStorage
  }
  // for cases when there is multiple "copies" of this module, we can't just init
  // AsyncLocalStorage in the module scope, because it will be different for each
  // copy - so first time an instance of this module is used, we store AsyncLocalStorage
  // in global scope and reuse it for all subsequent calls
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
