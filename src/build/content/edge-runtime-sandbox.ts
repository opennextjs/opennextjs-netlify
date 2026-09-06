// Ships what src/run/handlers/edge-runtime-sandbox.ts needs into the server handler: the edge
// bundles of `runtime: 'edge'` outputs (from middleware-manifest.json, the adapter output's asset
// keys for edge outputs are not repoRoot-relative) and Next's edge sandbox with its dependency tree.
// Delete together with that module.
import { cp, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'

import type { MiddlewareManifest } from 'next-with-adapters/dist/build/webpack/plugins/middleware-plugin.js'

import type { PluginContextAdapter } from '../plugin-context.js'

const SANDBOX_ENTRY = 'next/dist/server/web/sandbox/index.js'
// Next's own bundled copy of @vercel/nft, the one it traces `next-server` with for standalone output
const NFT_ENTRY = 'next/dist/compiled/@vercel/nft'

export const copyEdgeRuntimeOutputs = async (ctx: PluginContextAdapter): Promise<void> => {
  const { outputs, repoRoot, projectDir, distDir } = ctx.adapterOutput
  const edgeOutputIds = new Set(
    [...outputs.pages, ...outputs.pagesApi, ...outputs.appPages, ...outputs.appRoutes]
      .filter((output) => output.runtime === 'edge')
      .map((output) => output.id),
  )
  if (edgeOutputIds.size === 0) {
    return
  }

  const files = new Map<string, string>()
  const addFile = (relPath: string, absPath: string) =>
    files.set(join(ctx.serverHandlerRootDir, relPath), absPath)

  const manifestRelPath = 'server/middleware-manifest.json'
  const manifest = JSON.parse(
    await readFile(join(distDir, manifestRelPath), 'utf-8'),
  ) as MiddlewareManifest
  const distDirRelPath = relative(repoRoot, distDir)
  addFile(join(distDirRelPath, manifestRelPath), join(distDir, manifestRelPath))
  for (const definition of Object.values(manifest.functions)) {
    if (!edgeOutputIds.has(definition.name)) {
      continue
    }
    for (const file of [
      ...definition.files,
      ...(definition.wasm ?? []).map((binding) => binding.filePath),
      ...(definition.assets ?? []).map((asset) => asset.filePath),
    ]) {
      addFile(join(distDirRelPath, file), join(distDir, file))
    }
  }

  // the sandbox lives in the app's Next.js, only Next's traced per-output assets are shipped otherwise
  const requireFromApp = createRequire(join(projectDir, 'package.json'))
  const { nodeFileTrace } = requireFromApp(NFT_ENTRY) as typeof import('@vercel/nft')
  const { fileList } = await nodeFileTrace([requireFromApp.resolve(SANDBOX_ENTRY)], {
    base: repoRoot,
  })
  for (const file of fileList) {
    addFile(file, join(repoRoot, file))
  }

  await Promise.all(
    [...files].map(async ([destPath, srcPath]) => {
      await mkdir(dirname(destPath), { recursive: true })
      await cp(srcPath, destPath, { recursive: true, force: true, verbatimSymlinks: true })
    }),
  )
}
