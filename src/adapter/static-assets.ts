import { existsSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { extname, join } from 'node:path/posix'

import { NEXT_RUNTIME_STATIC_ASSETS } from './constants.js'
import type { FrameworksAPIConfig, OnBuildCompleteContext } from './types.js'

export async function onBuildComplete(
  ctx: OnBuildCompleteContext,
  frameworksAPIConfigArg: FrameworksAPIConfig,
) {
  const frameworksAPIConfig: FrameworksAPIConfig = frameworksAPIConfigArg ?? {}

  for (const staticFile of ctx.outputs.staticFiles) {
    try {
      let distPathname = staticFile.pathname
      if (extname(distPathname) === '' && extname(staticFile.filePath) === '.html') {
        // FEEDBACK: should this be applied in Next.js before passing to context to adapters?
        if (ctx.config.trailingSlash && !distPathname.endsWith('/')) {
          distPathname += '/'
        } else if (!ctx.config.trailingSlash && distPathname.endsWith('/')) {
          distPathname = distPathname.slice(0, -1)
        }

        // if pathname is extension-less, but source file has an .html extension, preserve it
        distPathname += distPathname.endsWith('/') ? 'index.html' : '.html'
      }

      await cp(staticFile.filePath, join(NEXT_RUNTIME_STATIC_ASSETS, distPathname), {
        recursive: true,
      })
    } catch (error) {
      throw new Error(`Failed copying static asset.\n\n${JSON.stringify(staticFile, null, 2)}`, {
        cause: error,
      })
    }
  }

  // FEEDBACK: files in public directory are not in `outputs.staticFiles`
  if (existsSync('public')) {
    // copy all files from public directory to static assets
    await cp('public', NEXT_RUNTIME_STATIC_ASSETS, {
      recursive: true,
    })
  }

  return frameworksAPIConfig
}
