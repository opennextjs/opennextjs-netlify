// NOTE: This is a fragment of a JavaScript program that will be inlined with
// a Webpack bundle. You should not import this file from anywhere in the
// application.
import { AsyncLocalStorage } from 'node:async_hooks'
import process from 'node:process'
import * as BufferCompat from 'node:buffer'
import * as EventsCompat from 'node:events'
import * as AsyncHooksCompat from 'node:async_hooks'
import * as AssertCompat from 'node:assert'
import * as UtilCompat from 'node:util'

globalThis.process = process

globalThis.AsyncLocalStorage = AsyncLocalStorage

// next.js generates require("node:buffer") statemenents:
// https://github.com/vercel/next.js/blob/89e68377baf3ea6d2bf09e0ae694f57ec5c8ea93/packages/next/src/build/webpack-config.ts#L1677-L1684
// we need to shim them, because require doesn't work on Deno
// we've also added a few more shims that Next.js also shims in their own sandbox:
// https://github.com/vercel/next.js/blob/55b472b5fc8da9a97ffca0070befa80ae431217f/packages/next/src/server/web/sandbox/context.ts#L177
globalThis.require = function nextRuntimeMinimalRequireShim(name) {
  switch (name.replace(/^node:/, '')) {
    case 'buffer':
      return BufferCompat
    case 'events':
      return EventsCompat
    case 'async_hooks':
      return AsyncHooksCompat
    case 'assert':
      return AssertCompat
    case 'util':
      return UtilCompat
    default:
      throw new ReferenceError(`require is not defined`)
  }
}

var _ENTRIES = {}
try {
  // turbopack builds use self._ENTRIES not globalThis._ENTRIES
  // so making sure both points to same object
  self._ENTRIES = _ENTRIES
} catch {}
