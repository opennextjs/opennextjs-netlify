// @ts-check
// deno-lint-ignore-file prefer-const no-unused-vars
import { decode as _base64Decode } from '../vendor/deno.land/std@0.175.0/encoding/base64.ts'
import BufferCompat from '../vendor/deno.land/std@0.175.0/node/buffer.ts'
import EventsCompat from '../vendor/deno.land/std@0.175.0/node/events.ts'
import AsyncHooksCompat from '../vendor/deno.land/std@0.175.0/node/async_hooks.ts'
import AssertCompat from '../vendor/deno.land/std@0.175.0/node/assert.ts'
import UtilCompat from '../vendor/deno.land/std@0.175.0/node/util.ts'

/**
 * These are the shims, polyfills and other kludges to make Next.js work in standards-compliant runtime.
 * This file isn't imported, but is instead inlined along with other chunks into the edge bundle.
 */

// Deno defines "window", but naughty libraries think this means it's a browser
// @ts-ignore
delete globalThis.window
globalThis.process = {
  env: { ...Deno.env.toObject(), NEXT_RUNTIME: 'edge', NEXT_PRIVATE_MINIMAL_MODE: '1' },
}
globalThis.EdgeRuntime = 'netlify-edge'
let _ENTRIES = {}

// Next.js expects this as a global
globalThis.AsyncLocalStorage = AsyncHooksCompat.AsyncLocalStorage

// Next.js uses this extension to the Headers API implemented by Cloudflare workerd
if (!('getAll' in Headers.prototype)) {
  // @ts-ignore
  Headers.prototype.getAll = function getAll(name) {
    name = name.toLowerCase()
    if (name !== 'set-cookie') {
      throw new Error('Headers.getAll is only supported for Set-Cookie')
    }
    return [...this.entries()].filter(([key]) => key === name).map(([, value]) => value)
  }
}
//  Next uses blob: urls to refer to local assets, so we need to intercept these
const _fetch = globalThis.fetch
/* type {typeof globalThis.fetch} */
globalThis.fetch = async function fetch (url, init) {
  try {
    if (url instanceof URL && url.href?.startsWith('blob:')) {
      const key = url.href.slice(5)
      if (key in _ASSETS) {
        return new Response(_base64Decode(_ASSETS[key]))
      }
    }
    return await _fetch(url, init)
  } catch (error) {
    console.error(error)
    throw error
  }
}

// Shim native modules that Vercel makes available
if (typeof require === 'undefined') {
  globalThis.require = (name) => {
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
        throw new ReferenceError(`Native module not found: ${name}`)
    }
  }
}

// Next edge runtime uses "self" as a function-scoped global-like object, but some of the older polyfills expect it to equal globalThis
// See https://nextjs.org/docs/basic-features/supported-browsers-features#polyfills
globalThis.self = { ...globalThis, fetch }
