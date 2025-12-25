import { cp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, context } from 'esbuild'
import glob from 'fast-glob'

import { vendorDeno } from './build-helpers.js'

const OUT_DIR = 'dist'
await rm(OUT_DIR, { force: true, recursive: true })

const repoDirectory = dirname(resolve(fileURLToPath(import.meta.url), '..'))

const entryPointsESM = await glob('src/**/*.ts', {
  ignore: ['**/*.test.ts', 'src/adapter/vendor/**/*'],
})
const entryPointsCJS = await glob('src/**/*.cts', {
  ignore: ['**/*.test.ts', 'src/adapter/vendor/**/*'],
})

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
            if (
              args.importer.includes(join(repoDirectory, 'src')) &&
              !args.path.includes(join('vendor', '@next', 'routing'))
            ) {
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
      var __filename = ''
      var __dirname = ''
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

async function vendorMiddlewareDenoModules() {
  const vendorSource = resolve('edge-runtime/vendor.ts')
  const middlewareDir = resolve('edge-runtime')

  await vendorDeno({
    vendorSource,
    cwd: middlewareDir,
    wasmFilesToDownload: ['https://deno.land/x/htmlrewriter@v1.0.0/pkg/htmlrewriter_bg.wasm'],
  })
}

const args = new Set(process.argv.slice(2))
const watch = args.has('--watch') || args.has('-w')

await Promise.all([
  vendorMiddlewareDenoModules(),
  bundle(entryPointsESM, 'esm', watch),
  ...entryPointsCJS.map((entry) => bundle([entry], 'cjs', watch)),
  cp('src/build/templates', join(OUT_DIR, 'build/templates'), { recursive: true, force: true }),
])

async function ensureNoRegionalBlobsModuleDuplicates() {
  const REGIONAL_BLOB_STORE_CONTENT_TO_FIND = 'fetchBeforeNextPatchedIt'
  const EXPECTED_MODULE_TO_CONTAIN_FETCH_BEFORE_NEXT_PATCHED_IT =
    'run/storage/regional-blob-store.cjs'

  const filesToTest = await glob(`${OUT_DIR}/**/*.{js,cjs}`)
  const unexpectedModulesContainingFetchBeforeNextPatchedIt = []
  let foundInExpectedModule = false

  for (const fileToTest of filesToTest) {
    const content = await readFile(fileToTest, 'utf-8')
    if (content.includes(REGIONAL_BLOB_STORE_CONTENT_TO_FIND)) {
      if (fileToTest.endsWith(EXPECTED_MODULE_TO_CONTAIN_FETCH_BEFORE_NEXT_PATCHED_IT)) {
        foundInExpectedModule = true
      } else {
        unexpectedModulesContainingFetchBeforeNextPatchedIt.push(fileToTest)
      }
    }
  }
  if (!foundInExpectedModule) {
    throw new Error(
      `Expected to find "fetchBeforeNextPatchedIt" variable in "${EXPECTED_MODULE_TO_CONTAIN_FETCH_BEFORE_NEXT_PATCHED_IT}", but it was not found. This might indicate a setup change that requires the bundling validation in "tools/build.js" to be adjusted.`,
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
