import { getRequestContext } from './request-context.cjs'

/**
 *  @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/after/builtin-request-context.ts
 */
const NEXT_REQUEST_CONTEXT_SYMBOL = Symbol.for('@next/request-context')

export type NextJsRequestContext = {
  get(): { waitUntil?: (promise: Promise<unknown>) => void } | undefined
}

type GlobalThisWithRequestContext = typeof globalThis & {
  [NEXT_REQUEST_CONTEXT_SYMBOL]?: NextJsRequestContext
}

/**
 * Registers a `waitUntil` to be used by Next.js for next/after
 */
export function setupWaitUntil() {
  // eslint-disable-next-line @typescript-eslint/no-extra-semi
  ;(globalThis as GlobalThisWithRequestContext)[NEXT_REQUEST_CONTEXT_SYMBOL] = {
    get() {
      return { waitUntil: getRequestContext()?.trackBackgroundWork }
    },
  }
}
