import { cp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

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

export async function vendorDeno(dir) {
  const vendorSource = resolve(join(dir, 'vendor.ts'))
  const vendorDest = resolve(join(dir, 'vendor'))

  try {
    await execaCommand('deno --version')
  } catch {
    throw new Error('Could not check the version of Deno. Is it installed on your system?')
  }

  console.log(`🧹 Deleting '${vendorDest}'...`)

  await rm(vendorDest, { force: true, recursive: true })

  console.log(`📦 Vendoring Deno modules into '${vendorDest}'...`)

  await execaCommand(`deno vendor ${vendorSource} --output=${vendorDest} --force`)
}

const args = new Set(process.argv.slice(2))
const watch = args.has('--watch') || args.has('-w')

await Promise.all([
  vendorDeno('edge-runtime'),
  bundle(entryPointsESM, 'esm', watch),
  ...entryPointsCJS.map((entry) => bundle([entry], 'cjs', watch)),
  cp('src/build/templates', join(OUT_DIR, 'build/templates'), { recursive: true, force: true }),
])

if (watch) {
  console.log('Starting compilation in watch mode...')
} else {
  console.log('Finished building 🎉')
}
