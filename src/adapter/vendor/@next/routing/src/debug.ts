import { AsyncLocalStorage } from 'node:async_hooks'
import { format } from 'node:util'

export type RequestTracker = {
  logs: string
}

export const RequestTrackerAsyncLocalStorage = new AsyncLocalStorage<RequestTracker>()

export function debugLog(...args: unknown[]) {
  const store = RequestTrackerAsyncLocalStorage.getStore()
  if (store) {
    store.logs += `${format(...args)}\n\n`
  }
}
