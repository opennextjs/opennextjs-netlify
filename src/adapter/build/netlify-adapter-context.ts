import type { FrameworksAPIConfig } from './types.js'

export function createNetlifyAdapterContext() {
  return {
    frameworksAPIConfig: undefined as FrameworksAPIConfig | undefined,
    preparedOutputs: {
      staticAssets: [] as string[],
      staticAssetsAliases: {} as Record<string, string>,
      endpoints: [] as string[],
      middleware: false,
    },
  }
}
