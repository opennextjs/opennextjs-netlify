// Ships what src/run/handlers/edge-runtime-sandbox.ts needs on top of the regular output assets:
// middleware-manifest.json, the sandbox is driven by its `functions` entries. Delete together with
// that module.
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
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

  // Route modules build absolute URLs (the `fetch` of a server action's redirect target, say) from
  // `localhost` unless they trust the `host` header, which is the site's domain here. Same as
  // Vercel: Next.js writes `trustHostHeader: true` into this manifest when building there
  // (`ciEnvironment.hasNextSupport`, build/index.ts), and ignores the config value otherwise, so
  // it's patched here. Edge outputs can't use the `initURL` request meta node outputs get instead
  // (WebNextRequest drops it).
  const serverFilesPath = join(
    ctx.serverHandlerRootDir,
    relative(repoRoot, distDir),
    'required-server-files.js',
  )
  const prefix = 'self.__SERVER_FILES_MANIFEST='
  const serverFiles = existsSync(serverFilesPath) ? await readFile(serverFilesPath, 'utf-8') : ''
  if (serverFiles.startsWith(prefix)) {
    const manifest = JSON.parse(serverFiles.slice(prefix.length))
    manifest.config.experimental.trustHostHeader = true
    await writeFile(serverFilesPath, `${prefix}${JSON.stringify(manifest)}`)
  }
}
