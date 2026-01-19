import { decode as base64Decode } from './vendor/deno.land/std@0.175.0/encoding/base64.ts'
import { init as htmlRewriterInit } from './vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'

let wasmGzipBase64: string | null = '__HTML_REWRITER_WASM_GZIP_BASE64__'

let initialized = false

function decompress(compressedData: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([compressedData as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

export async function initHtmlRewriter(): Promise<void> {
  if (initialized || !wasmGzipBase64) {
    return
  }
  const compressed = base64Decode(wasmGzipBase64)
  const wasmBuffer = await decompress(compressed)
  await htmlRewriterInit({ module_or_path: wasmBuffer })
  wasmGzipBase64 = null
  initialized = true
}
