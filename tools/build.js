import { createWriteStream } from 'node:fs'
import { cp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'stream'
import { finished } from 'stream/promises'

import { build, context } from 'esbuild'
import { execaCommand } from 'execa'
import glob from 'fast-glob'

const OUT_DIR = 'dist'
await rm(OUT_DIR, { force: true, recursive: true })

const entryPointsESM = await glob('src/**/*.ts', { ignore: ['**/*.test.ts'] })
const entryPointsCJS = await glob('src/**/*.cts')

/**
 *
 * @param {string[]} entryPoints
 * @param {'esm' | 'cjs'} format
 * @param {boolean=} watch
 * @returns
 */
async function bundle(entryPoints, format, watch) {
  /** @type {import('esbuild').BuildOptions} */
  const options = {
    entryPoints,
    entryNames: '[dir]/[name]',
    bundle: true,
    platform: 'node',
    target: 'node18',
    format,
    external: ['next'], // don't try to bundle next
    allowOverwrite: watch,
    plugins: [
      {
        // runtime modules are all entrypoints, so importing them should mark them as external
        // to avoid duplicating them in the bundle (which also can cause import path issues)
        name: 'mark-runtime-modules-as-external',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^\..*\.c?js$/ }, (args) => {
            if (args.importer.includes(join('opennextjs-netlify', 'src'))) {
              return { path: args.path, external: true }
            }
          })
        },
      },
    ],
  }

  if (format === 'esm') {
    options.outdir = OUT_DIR
    options.chunkNames = 'esm-chunks/[name]-[hash]'
    options.splitting = true
    options.banner = {
      // this shim is needed for cjs modules that are imported in ESM :(
      // explicitly use var as it might be already defined in some cases
      js: `
      var require = await (async () => {
        var { createRequire } = await import("node:module");
        return createRequire(import.meta.url);
      })();
    `,
    }
  } else {
    options.outfile = entryPoints[0].replace('src', OUT_DIR).replace('cts', 'cjs')
  }

  if (!watch) {
    return build(options)
  }
  const ctx = await context(options)
  await ctx.watch()

  process.on('SIGINT', () => {
    ctx.dispose().then(() => {
      // eslint-disable-next-line n/no-process-exit
      process.exit()
    })
  })
}

async function vendorDeno() {
  const vendorSource = resolve('edge-runtime/vendor.ts')
  const vendorDest = resolve('edge-runtime/vendor')

  try {
    await execaCommand('deno --version')
  } catch {
    throw new Error('Could not check the version of Deno. Is it installed on your system?')
  }

  console.log(`🧹 Deleting '${vendorDest}'...`)

  await rm(vendorDest, { force: true, recursive: true })

  console.log(`📦 Vendoring Deno modules into '${vendorDest}'...`)

  await execaCommand(`deno vendor ${vendorSource} --output=${vendorDest} --force`)

  // htmlrewriter contains wasm files and those don't currently work great with vendoring
  // see https://github.com/denoland/deno/issues/14123
  // to workaround this we copy the wasm files manually
  const filesToDownload = ['https://deno.land/x/htmlrewriter@v1.0.0/pkg/htmlrewriter_bg.wasm']
  await Promise.all(
    filesToDownload.map(async (urlString) => {
      const url = new URL(urlString)

      const destination = join(vendorDest, url.hostname, url.pathname)

      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to fetch .wasm file to vendor', { cause: err })
      const fileStream = createWriteStream(destination, { flags: 'wx' })
      await finished(Readable.fromWeb(res.body).pipe(fileStream))
    }),
  )
}

const args = new Set(process.argv.slice(2))
const watch = args.has('--watch') || args.has('-w')

await Promise.all([
  vendorDeno(),
  bundle(entryPointsESM, 'esm', watch),
  ...entryPointsCJS.map((entry) => bundle([entry], 'cjs', watch)),
  cp('src/build/templates', join(OUT_DIR, 'build/templates'), { recursive: true, force: true }),
])

async function ensureNoRegionalBlobsModuleDuplicates() {
  const REGIONAL_BLOB_STORE_CONTENT_TO_FIND = 'fetchBeforeNextPatchedIt'

  const filesToTest = await glob(`${OUT_DIR}/**/*.{js,cjs}`)
  const unexpectedModulesContainingFetchBeforeNextPatchedIt = []
  let foundInExpectedModule = false
  for (const fileToTest of filesToTest) {
    const content = await readFile(fileToTest, 'utf-8')
    if (content.includes(REGIONAL_BLOB_STORE_CONTENT_TO_FIND)) {
      if (fileToTest.endsWith('run/regional-blob-store.cjs')) {
        foundInExpectedModule = true
      } else {
        unexpectedModulesContainingFetchBeforeNextPatchedIt.push(fileToTest)
      }
    }
  }
  if (!foundInExpectedModule) {
    throw new Error(
      'Expected to find "fetchBeforeNextPatchedIt" variable in "run/regional-blob-store.cjs", but it was not found. This might indicate setup change that require bundling validation in "tools/build.js" to be adjusted.',
    )
  }
  if (unexpectedModulesContainingFetchBeforeNextPatchedIt.length !== 0) {
    throw new Error(
      `Bundling produced unexpected duplicates of "regional-blob-store" module in following built modules:\n${unexpectedModulesContainingFetchBeforeNextPatchedIt.map((filePath) => ` - ${filePath}`).join('\n')}`,
    )
  }
}

if (watch) {
  console.log('Starting compilation in watch mode...')
} else {
  await ensureNoRegionalBlobsModuleDuplicates()

  console.log('Finished building 🎉')
}
