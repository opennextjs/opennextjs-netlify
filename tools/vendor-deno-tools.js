import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { vendorDeno } from './build-helpers.js'

const denoToolsDirectory = join(dirname(fileURLToPath(import.meta.url)), 'deno')

await vendorDeno({
  vendorSource: join(denoToolsDirectory, 'eszip.ts'),
  cwd: denoToolsDirectory,
  wasmFilesToDownload: ['https://deno.land/x/eszip@v0.55.4/eszip_wasm_bg.wasm'],
  initEmptyDenoJson: true,
})
