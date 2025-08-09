import { createWriteStream } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'stream'
import { finished } from 'stream/promises'

import { execaCommand } from 'execa'

/**
 * @param {Object} options
 * @param {string} options.vendorSource Path to the file to vendor
 * @param {string} options.cwd Directory to run the command in
 * @param {string[]} [options.wasmFilesToDownload] List of wasm files to download
 * @param {boolean} [options.initEmptyDenoJson] If true, will create an empty deno.json file
 */
export async function vendorDeno({
  vendorSource,
  cwd,
  wasmFilesToDownload = [],
  initEmptyDenoJson = false,
}) {
  try {
    await execaCommand('deno --version')
  } catch {
    throw new Error('Could not check the version of Deno. Is it installed on your system?')
  }

  const vendorDest = join(cwd, 'vendor')

  console.log(`🧹 Deleting '${vendorDest}'...`)

  await rm(vendorDest, { force: true, recursive: true })

  if (initEmptyDenoJson) {
    const denoJsonPath = join(cwd, 'deno.json')
    console.log(`🧹 Generating clean '${denoJsonPath}`)
    await writeFile(denoJsonPath, '{ "vendor": true }')
  }

  console.log(`📦 Vendoring Deno modules for '${vendorSource}' into '${vendorDest}'...`)
  await execaCommand(`deno --allow-import ${vendorSource}`, {
    cwd,
  })

  if (wasmFilesToDownload.length !== 0) {
    console.log(`⬇️ Downloading wasm files...`)

    // deno vendor doesn't work well with wasm files
    // see https://github.com/denoland/deno/issues/14123
    // to workaround this we copy the wasm files manually
    // (note Deno 2 allows to vendor wasm files, but it also require modules to import them and not fetch and instantiate them
    // so being able to drop downloading is dependent on implementation of wasm handling in external modules as well)
    await Promise.all(
      wasmFilesToDownload.map(async (urlString) => {
        const url = new URL(urlString)

        const destination = join(vendorDest, url.hostname, url.pathname)

        const res = await fetch(url)
        if (!res.ok)
          throw new Error(`Failed to fetch .wasm file to vendor. Response status: ${res.status}`)
        const fileStream = createWriteStream(destination, { flags: 'wx' })
        await finished(Readable.fromWeb(res.body).pipe(fileStream))
      }),
    )
  }

  console.log(`✅ Vendored Deno modules for '${vendorSource}' into '${vendorDest}'`)
}
