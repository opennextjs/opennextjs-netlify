import { cp, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { trace } from '@opentelemetry/api'
import { wrapTracer } from '@opentelemetry/api/experimental'

import { ADAPTER_MANIFEST_FILE } from '../../run/constants.js'
import type { PluginContext } from '../plugin-context.js'

import { writeRunConfig } from './server.js'

const tracer = wrapTracer(trace.getTracer('Next runtime'))

/**
 * Copy Next.js server code using adapter-provided traced assets instead of standalone output.
 * Collects all assets from all function outputs and copies them preserving relative paths.
 */
export const copyNextServerCodeFromAdapter = async (ctx: PluginContext): Promise<void> => {
  await tracer.withActiveSpan('copyNextServerCodeFromAdapter', async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const adapterOutput = ctx.adapterOutput!

    await mkdir(ctx.serverHandlerDir, { recursive: true })
    await writeRunConfig(ctx)

    // Write the adapter manifest (routing + output metadata) for runtime use.
    // filePaths are already relative (rewritten in the adapter's onBuildComplete).
    await writeFile(
      join(ctx.serverHandlerDir, ADAPTER_MANIFEST_FILE),
      JSON.stringify({
        routing: adapterOutput.routing,
        outputs: adapterOutput.outputs,
        buildId: adapterOutput.buildId,
        config: adapterOutput.config,
      }),
      'utf-8',
    )

    // Collect all assets from all function outputs into a unified map
    // key = relative path from repoRoot, value = absolute path on disk
    const allAssets = new Map<string, string>()
    const outputArrays = [
      adapterOutput.outputs.pages,
      adapterOutput.outputs.pagesApi,
      adapterOutput.outputs.appPages,
      adapterOutput.outputs.appRoutes,
    ] as const

    for (const outputs of outputArrays) {
      for (const output of outputs) {
        if (output.runtime !== 'nodejs') {
          console.log(
            `Skipping non-nodejs output ${output.filePath} with runtime ${output.runtime}`,
          )
          continue
        }
        // filePath is already relative to repoRoot (rewritten in adapter's onBuildComplete).
        // Resolve the absolute source path for copying.
        allAssets.set(output.filePath, join(adapterOutput.repoRoot, output.filePath))

        // Add all traced assets
        for (const [relPath, absPath] of Object.entries(output.assets)) {
          allAssets.set(relPath, absPath)
        }
      }
    }

    // Copy all collected assets preserving relative paths
    const copyPromises: Promise<void>[] = []
    for (const [relPath, absPath] of allAssets) {
      const destPath = join(ctx.serverHandlerRootDir, relPath)
      copyPromises.push(
        mkdir(dirname(destPath), { recursive: true }).then(() =>
          cp(absPath, destPath, { recursive: true, force: true }),
        ),
      )
    }
    await Promise.all(copyPromises)
  })
}
