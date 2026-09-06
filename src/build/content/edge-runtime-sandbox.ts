// Ships what src/run/handlers/edge-runtime-sandbox.ts needs on top of the regular output assets:
// middleware-manifest.json (the sandbox is driven by its `functions` entries) and Next's edge sandbox
// with its dependency tree. Delete together with that module.
import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'

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
  addFile(join(relative(repoRoot, distDir), manifestRelPath), join(distDir, manifestRelPath))

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
