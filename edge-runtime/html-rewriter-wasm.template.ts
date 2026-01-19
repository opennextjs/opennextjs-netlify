// Generated at plugin build time from htmlrewriter@v1.0.0 WASM
// This provides lazy initialization for HTMLRewriter - only loaded when needed

import { decode as base64Decode } from './vendor/deno.land/std@0.175.0/encoding/base64.ts'
import { init as htmlRewriterInit } from './vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'

// Base64-encoded HTMLRewriter WASM (from htmlrewriter@v1.0.0)
let wasmBase64: string | null = '__HTML_REWRITER_WASM_BASE64__'

let initialized = false

export async function initHtmlRewriter(): Promise<void> {
  if (initialized || !wasmBase64) {
    return
  }
  const wasmBuffer = base64Decode(wasmBase64).buffer
  await htmlRewriterInit({ module_or_path: wasmBuffer })
  wasmBase64 = null // Allow GC of the base64 string
  initialized = true
}
