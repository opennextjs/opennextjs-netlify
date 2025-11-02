import { readFile } from 'fs/promises'
import { join } from 'path/posix'

import type { FrameworksAPIConfig, OnBuildCompleteContext } from './types.js'

export function createNetlifyAdapterContext(nextAdapterContext: OnBuildCompleteContext) {
  let buildId: string | undefined

  return {
    async getBuildId() {
      if (!buildId) {
        buildId = await readFile(join(nextAdapterContext.distDir, 'BUILD_ID'), 'utf-8')
      }
      return buildId
    },
    frameworksAPIConfig: undefined as FrameworksAPIConfig | undefined,
    preparedOutputs: {
      staticAssets: [] as string[],
      staticAssetsAliases: {} as Record<string, string>,
      endpoints: [] as string[],
      middleware: false,
    },
  }
}
