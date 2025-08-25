// NOTE: This is a fragment of a JavaScript program that will be inlined with
// a Webpack bundle. You should not import this file from anywhere in the
// application.
import { AsyncLocalStorage } from 'node:async_hooks'

import { createRequire } from 'node:module' // used in dynamically generated part
import process from 'node:process'

import { registerCJSModules } from '../edge-runtime/lib/cjs.ts' // used in dynamically generated part

globalThis.process = process

globalThis.AsyncLocalStorage = AsyncLocalStorage

// needed for path.relative and path.resolve to work
Deno.cwd = () => ''
