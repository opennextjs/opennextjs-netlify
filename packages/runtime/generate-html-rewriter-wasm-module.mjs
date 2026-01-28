import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)

const wasmUrl = 'https://deno.land/x/htmlrewriter@v1.0.0/pkg/htmlrewriter_bg.wasm'

const htmlRewriterWasmTemplate = /* ts */ `import { decode as base64Decode } from '../vendor/deno.land/std@0.175.0/encoding/base64.ts'
import { init as htmlRewriterInit } from '../vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'

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
}`

const response = await fetch(wasmUrl)
const wasmBuffer = Buffer.from(await response.arrayBuffer())

const compressed = await gzipAsync(wasmBuffer, { level: 9 })
const wasmGzipBase64 = compressed.toString('base64')

const templatePath = join('./src/templates/edge-shared/html-rewriter-wasm.ts')
const moduleContent = htmlRewriterWasmTemplate.replace('__HTML_REWRITER_WASM_GZIP_BASE64__', wasmGzipBase64)
await writeFile(templatePath, moduleContent)
