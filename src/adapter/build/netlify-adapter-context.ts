import { readFile } from 'fs/promises'
import { join } from 'path/posix'

import type { FrameworksAPIConfig, OnBuildCompleteContext } from './types.js'

export function createNetlifyAdapterContext(nextAdapterContext: OnBuildCompleteContext) {
  let buildId: string | undefined
  let frameworksAPIConfig: FrameworksAPIConfig | undefined

  return {
    async getBuildId() {
      if (!buildId) {
        buildId = await readFile(join(nextAdapterContext.distDir, 'BUILD_ID'), 'utf-8')
      }
      return buildId
    },
    frameworksAPIConfig,
  }
}
