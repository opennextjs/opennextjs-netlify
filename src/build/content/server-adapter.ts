import { cp, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { join as posixJoin } from 'node:path/posix'

import { trace } from '@opentelemetry/api'
import { wrapTracer } from '@opentelemetry/api/experimental'

import type { AdapterManifest, AdapterManifestComputeOutput } from '../../run/config.js'
import { ADAPTER_MANIFEST_FILE } from '../../run/constants.js'
import type { PluginContextAdapter } from '../plugin-context.js'

import { copyEdgeRuntimeOutputs } from './edge-runtime-sandbox.js'
import { writeRunConfig } from './server.js'

const tracer = wrapTracer(trace.getTracer('Next runtime'))

const computeOutput = (output: AdapterManifestComputeOutput): AdapterManifestComputeOutput => ({
  id: output.id,
  pathname: output.pathname,
  sourcePage: output.sourcePage,
  runtime: output.runtime,
  filePath: output.filePath,
})

/**
 * Copy Next.js server code using adapter-provided traced assets instead of standalone output.
 * Collects all assets from all function outputs and copies them preserving relative paths.
 */
export const copyNextServerCodeFromAdapter = async (ctx: PluginContextAdapter): Promise<void> => {
  await tracer.withActiveSpan('copyNextServerCodeFromAdapter', async () => {
    await mkdir(ctx.serverHandlerDir, { recursive: true })
    await writeRunConfig(ctx)

    // Write the adapter manifest (routing + output metadata) for runtime use.
    // filePaths are already relative (rewritten in the adapter's onBuildComplete).
    // Outputs are projected down to the fields the runtime reads: the traced `assets`/`assetsHashes`
    // are only needed for the copying below and are ~96% of the serialized output, and the
    // middleware output is consumed solely by the edge function (its `config.env` secrets included).
    const manifest: AdapterManifest = {
      routing: ctx.adapterOutput.routing,
      outputs: {
        pages: ctx.adapterOutput.outputs.pages.map(computeOutput),
        pagesApi: ctx.adapterOutput.outputs.pagesApi.map(computeOutput),
        appPages: ctx.adapterOutput.outputs.appPages.map(computeOutput),
        appRoutes: ctx.adapterOutput.outputs.appRoutes.map(computeOutput),
        prerenders: ctx.adapterOutput.outputs.prerenders.map(
          ({ id, pathname, parentOutputId }) => ({
            id,
            pathname,
            parentOutputId,
          }),
        ),
        staticFiles: ctx.adapterOutput.outputs.staticFiles.map(({ pathname, filePath }) => ({
          pathname,
          filePath,
        })),
      },
      buildId: ctx.adapterOutput.buildId,
      config: ctx.adapterOutput.config,
      relativeProjectDir: ctx.adapterOutput.relativeProjectDir,
      relativeAppDir: ctx.relativeAppDir,
      publicPathnames: await ctx.getPublicPathnames(),
    }
    await writeFile(
      join(ctx.serverHandlerDir, ADAPTER_MANIFEST_FILE),
      JSON.stringify(manifest),
      'utf-8',
    )

    // Collect all assets from all function outputs into a unified map
    // key = relative path from repoRoot, value = absolute path on disk
    const allAssets = new Map<string, string>()
    const outputArrays = [
      ctx.adapterOutput.outputs.pages,
      ctx.adapterOutput.outputs.pagesApi,
      ctx.adapterOutput.outputs.appPages,
      ctx.adapterOutput.outputs.appRoutes,
    ] as const

    for (const outputs of outputArrays) {
      for (const output of outputs) {
        // filePath is already relative to repoRoot (rewritten in adapter's onBuildComplete).
        // Resolve the absolute source path for copying.
        allAssets.set(output.filePath, join(ctx.adapterOutput.repoRoot, output.filePath))

        // Add all traced assets. Keys are documented as repoRoot-relative, but for edge outputs Next
        // makes them relative to <repoRoot>/<distDir> instead, so derive the key from the absolute path.
        for (const absPath of [
          ...Object.values(output.assets),
          ...Object.values(output.wasmAssets ?? {}),
        ]) {
          allAssets.set(relative(ctx.adapterOutput.repoRoot, absPath), absPath)
        }
      }
    }

    // Next's server loads .env files at startup via @next/env, route modules don't. Ship the app's
    // copy next to the app dir in the handler so the runtime can do the same (see server-adapter.ts).
    const requireFromApp = createRequire(join(ctx.adapterOutput.projectDir, 'package.json'))
    const requireFromNext = createRequire(requireFromApp.resolve('next/package.json'))
    allAssets.set(
      posixJoin(ctx.relativeAppDir, 'node_modules/@next/env'),
      dirname(requireFromNext.resolve('@next/env/package.json')),
    )

    // Copy all collected assets preserving relative paths
    const copyPromises: Promise<void>[] = []
    for (const [relPath, absPath] of allAssets) {
      const destPath = join(ctx.serverHandlerRootDir, relPath)
      copyPromises.push(
        mkdir(dirname(destPath), { recursive: true }).then(() =>
          cp(absPath, destPath, { recursive: true, force: true, verbatimSymlinks: true }),
        ),
      )
    }
    await Promise.all(copyPromises)

    await copyEdgeRuntimeOutputs(ctx)
  })
}
