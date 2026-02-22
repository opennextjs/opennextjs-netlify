import { writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { NextAdapter } from 'next-with-adapters'

import { NETLIFY_IMAGE_LOADER_FILE } from '../build/image-cdn.js'

import { ADAPTER_OUTPUT_FILE } from './adapter-output.js'
import type { SerializedAdapterOutput } from './adapter-output.js'

const adapter: NextAdapter = {
  name: 'Netlify',
  modifyConfig(config, ctx) {
    if (ctx?.phase === 'phase-production-build' && config.output !== 'export') {
      // TODO(adapter)
      // If not export, make sure to not build standalone output as it will become useless
      // // @ts-expect-error types don't unsetting output to not use 'standalone'
      // config.output = undefined
    }

    if (config.images.loader === 'default') {
      // Set up Netlify Image CDN image's loaderFile
      // see https://nextjs.org/docs/app/api-reference/config/next-config-js/images
      config.images.loader = 'custom'
      config.images.loaderFile = NETLIFY_IMAGE_LOADER_FILE
    }

    return config
  },
  async onBuildComplete(ctx) {
    // Convert absolute filePaths to relative (from repoRoot) so the serialized
    // output never contains machine-specific paths. At runtime these are
    // resolved against process.cwd().
    const toRelPath = (absPath: string) => relative(ctx.repoRoot, absPath)
    const rewriteOutputs = <T extends { filePath: string }>(outputs: T[]): T[] =>
      outputs.map((output) => ({ ...output, filePath: toRelPath(output.filePath) }))

    const serialized: SerializedAdapterOutput = {
      routing: ctx.routing,
      outputs: {
        pages: rewriteOutputs(ctx.outputs.pages),
        pagesApi: rewriteOutputs(ctx.outputs.pagesApi),
        appPages: rewriteOutputs(ctx.outputs.appPages),
        appRoutes: rewriteOutputs(ctx.outputs.appRoutes),
        prerenders: ctx.outputs.prerenders,
        staticFiles: ctx.outputs.staticFiles,
        middleware: ctx.outputs.middleware,
      },
      projectDir: ctx.projectDir,
      repoRoot: ctx.repoRoot,
      distDir: ctx.distDir,
      config: ctx.config,
      nextVersion: ctx.nextVersion,
      buildId: ctx.buildId,
    }

    await writeFile(join(ctx.distDir, ADAPTER_OUTPUT_FILE), JSON.stringify(serialized), 'utf-8')
  },
}

export default adapter
