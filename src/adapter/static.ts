import { cp } from 'node:fs/promises'
import { join } from 'node:path/posix'

import type { FrameworksAPIConfig, OnBuildCompleteContext } from './types.js'

export async function onBuildComplete(
  ctx: OnBuildCompleteContext,
  frameworksAPIConfigArg: FrameworksAPIConfig,
) {
  const frameworksAPIConfig: FrameworksAPIConfig = frameworksAPIConfigArg ?? {}

  for (const staticFile of ctx.outputs.staticFiles) {
    try {
      await cp(staticFile.filePath, join('./.netlify/static', staticFile.pathname), {
        recursive: true,
      })
    } catch (error) {
      throw new Error(`Failed copying static assets`, { cause: error })
    }
  }

  return frameworksAPIConfig
}
