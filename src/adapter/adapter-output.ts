import { relative } from 'node:path'

import type { NextAdapter } from 'next-with-adapters'

export const ADAPTER_OUTPUT_FILE = 'netlify-adapter-output.json'

/**
 * The context passed to `onBuildComplete`, extracted from the adapter type.
 */
export type AdapterBuildCompleteContext = NonNullable<
  Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0]
>

export function normalizeAndFixAdapterOutput(
  onBuildCompleteAdapterCtx: AdapterBuildCompleteContext,
): AdapterBuildCompleteContext {
  return fixAdapterOutput(normalizeAdapterOutput(onBuildCompleteAdapterCtx))
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

// Some routing rules don't play with @next/routing (at least as it works today)
// so this is meant to massage things a bit so it works - ideally this is eventually removed
// once things are either fixed upstream ... or maybe assumptions we've made about hot it should
// are proven incorrect and we'll adjust usage to fit.
function fixAdapterOutput(
  onBuildCompleteAdapterCtx: AdapterBuildCompleteContext,
): AdapterBuildCompleteContext {
  return {
    ...onBuildCompleteAdapterCtx,
    routing: {
      ...onBuildCompleteAdapterCtx.routing,
      beforeMiddleware: onBuildCompleteAdapterCtx.routing.beforeMiddleware.map((rule) => {
        // trailing slash redirect should always ignore /_next/data requests
        if (rule.source?.startsWith('/:notfile')) {
          return {
            ...rule,
            missing: [
              {
                type: 'header',
                key: 'x-nextjs-data',
              },
            ],
          }
        }
        return rule
      }),
    },
  }
}
