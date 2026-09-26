import { relative } from 'node:path'

import type { NextAdapter } from 'next-with-adapters'

export const ADAPTER_OUTPUT_FILE = 'netlify-adapter-output.json'

/**
 * The context passed to `onBuildComplete`, extracted from the adapter type.
 */
export type AdapterBuildCompleteContext = NonNullable<
  Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0]
> & {
  // added by our adapter's onBuildComplete, see adapter.ts
  relativeProjectDir: string
}

export function normalizeAndFixAdapterOutput(
  onBuildCompleteAdapterCtx: AdapterBuildCompleteContext,
): AdapterBuildCompleteContext {
  return normalizeAdapterOutput(onBuildCompleteAdapterCtx)
}

function normalizeAdapterOutput(
  onBuildCompleteAdapterCtx: AdapterBuildCompleteContext,
): AdapterBuildCompleteContext {
  const toRelPath = (absPath: string) => relative(onBuildCompleteAdapterCtx.repoRoot, absPath)

  const rewriteOutputFilePath = <T extends { filePath: string }>(output: T): T => ({
    ...output,
    filePath: toRelPath(output.filePath),
  })

  const rewriteOutputsFilePaths = <T extends { filePath: string }>(outputs: T[]): T[] =>
    outputs.map(rewriteOutputFilePath)

  // Normalization:
  //  - convert absolute filePaths to relative (from repoRoot)
  return {
    ...onBuildCompleteAdapterCtx,
    outputs: {
      ...onBuildCompleteAdapterCtx.outputs,
      pages: rewriteOutputsFilePaths(onBuildCompleteAdapterCtx.outputs.pages),
      pagesApi: rewriteOutputsFilePaths(onBuildCompleteAdapterCtx.outputs.pagesApi),
      appPages: rewriteOutputsFilePaths(onBuildCompleteAdapterCtx.outputs.appPages),
      appRoutes: rewriteOutputsFilePaths(onBuildCompleteAdapterCtx.outputs.appRoutes),
      staticFiles: rewriteOutputsFilePaths(onBuildCompleteAdapterCtx.outputs.staticFiles),
      middleware: onBuildCompleteAdapterCtx.outputs.middleware
        ? rewriteOutputFilePath(onBuildCompleteAdapterCtx.outputs.middleware)
        : undefined,
    },
  }
}
