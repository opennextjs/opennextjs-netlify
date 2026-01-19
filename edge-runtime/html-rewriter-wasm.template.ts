import { decode as base64Decode } from './vendor/deno.land/std@0.175.0/encoding/base64.ts'
import { init as htmlRewriterInit } from './vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'

let wasmBase64: string | null = '__HTML_REWRITER_WASM_BASE64__'

let initialized = false

export async function initHtmlRewriter(): Promise<void> {
  if (initialized || !wasmBase64) {
    return
  }
  const wasmBuffer = base64Decode(wasmBase64).buffer
  await htmlRewriterInit({ module_or_path: wasmBuffer })
  wasmBase64 = null
  initialized = true
}
