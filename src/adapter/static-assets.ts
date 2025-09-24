import { cp } from 'node:fs/promises'
import { extname, join } from 'node:path/posix'

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
        // if pathname is extension-less, but source file has an .html extension, preserve it
        distPathname += '.html'
      }

      await cp(staticFile.filePath, join('./.netlify/static', distPathname), {
        recursive: true,
      })
    } catch (error) {
      throw new Error(`Failed copying static asset.\n\n${JSON.stringify(staticFile, null, 2)}`, {
        cause: error,
      })
    }
  }

  return frameworksAPIConfig
}
