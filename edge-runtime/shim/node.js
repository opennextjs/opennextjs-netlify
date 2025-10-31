// NOTE: This is a fragment of a JavaScript program that will be inlined with
// a Webpack bundle. You should not import this file from anywhere in the
// application.
import { createRequire } from 'node:module' // used in dynamically generated part

import { registerCJSModules } from '../edge-runtime/lib/cjs.ts' // used in dynamically generated part

if (typeof process === 'undefined') {
  globalThis.process = (await import('node:process')).default
}

if (typeof AsyncLocalStorage === 'undefined') {
  globalThis.AsyncLocalStorage = (await import('node:async_hooks')).AsyncLocalStorage
}

if (typeof Buffer === 'undefined') {
  globalThis.Buffer = (await import('node:buffer')).Buffer
}

// needed for path.relative and path.resolve to work
Deno.cwd = () => ''
