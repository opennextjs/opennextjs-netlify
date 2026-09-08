// Ships what src/run/handlers/edge-runtime-sandbox.ts needs on top of the regular output assets:
// middleware-manifest.json, the sandbox is driven by its `functions` entries. Delete together with
// that module.
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import type { PluginContextAdapter } from '../plugin-context.js'

export const copyEdgeRuntimeOutputs = async (ctx: PluginContextAdapter): Promise<void> => {
  const { outputs, repoRoot, distDir } = ctx.adapterOutput
  const hasEdgeOutputs = [
    ...outputs.pages,
    ...outputs.pagesApi,
    ...outputs.appPages,
    ...outputs.appRoutes,
  ].some((output) => output.runtime === 'edge')
  if (!hasEdgeOutputs) {
    return
  }

  const manifestRelPath = 'server/middleware-manifest.json'
  const destPath = join(ctx.serverHandlerRootDir, relative(repoRoot, distDir), manifestRelPath)
  await mkdir(dirname(destPath), { recursive: true })
  await cp(join(distDir, manifestRelPath), destPath, { force: true })
}
