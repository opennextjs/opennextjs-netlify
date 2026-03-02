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
  return fixAdapterOutputForNextRouting(normalizeAdapterOutput(onBuildCompleteAdapterCtx))
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
// this primarily focus on those rules:

// @next/routing doesn't interpolate Location headers, just "destination"
//   {
//     "source": "/:file((?!\\.well-known(?:/.*)?)(?:[^/]+/)*[^/]+\\.\\w+)/",
//     "sourceRegex": "^(?:\\/((?!\\.well-known(?:\\/.*)?)(?:[^/]+\\/)*[^/]+\\.\\w+))\\/$",
//     "headers": {
//       "Location": "/$1"
//     },
//     "status": 308,
//     "missing": [
//       {
//         "type": "header",
//         "key": "x-nextjs-data"
//       }
//     ],
//     "priority": true
//   },

// this seems to match on next-data request due to processing order in @next/routing - it normalizes
// data request before handling redirects, so those /_next/data requests match on this rule
//   {
//     "source": "/:notfile((?!\\.well-known(?:/.*)?)(?:[^/]+/)*[^/\\.]+)",
//     "sourceRegex": "^(?:\\/((?!\\.well-known(?:\\/.*)?)(?:[^/]+\\/)*[^/\\.]+))$",
//     "headers": {
//       "Location": "/$1/"
//     },
//     "status": 308,
//     "priority": true
//   }
// ],

// additionally, when trailingSlash: true, the pathname matching for static files is not working
function fixAdapterOutputForNextRouting(
  onBuildCompleteAdapterCtx: AdapterBuildCompleteContext,
): AdapterBuildCompleteContext {
  const beforeFiles = [...onBuildCompleteAdapterCtx.routing.beforeFiles]
  if (onBuildCompleteAdapterCtx.config.trailingSlash) {
    // normalizing trailing slash path to one without it to fix the output matching
    beforeFiles.push({
      source: '/:path+/',
      sourceRegex: '^(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))\\/$',
      destination: '/$1',
    })
  }

  return {
    ...onBuildCompleteAdapterCtx,
    routing: {
      ...onBuildCompleteAdapterCtx.routing,
      beforeMiddleware: onBuildCompleteAdapterCtx.routing.beforeMiddleware.map((rule) => {
        let maybeConvertedRule = rule
        // due to ordering process in @next/routing, this rule DOES match on data requests,
        // even if it shouldn't (/_next/data/build-id/page.json -> /page)
        if (rule.source?.startsWith('/:notfile')) {
          maybeConvertedRule = {
            ...rule,
            missing: [
              {
                type: 'header',
                key: 'x-nextjs-data',
              },
            ],
          }
        }

        if (
          maybeConvertedRule.status &&
          maybeConvertedRule.headers &&
          maybeConvertedRule.status >= 300 &&
          maybeConvertedRule.status < 400
        ) {
          // rewrite location header to be destination, so it gets interpolated by @next/routing
          const locationHeaderName = Object.keys(maybeConvertedRule.headers).find(
            (headerName) => headerName.toLowerCase() === 'location',
          )
          if (locationHeaderName) {
            const locationValue = maybeConvertedRule.headers[locationHeaderName]
            maybeConvertedRule = {
              ...maybeConvertedRule,
              destination: locationValue,
            }
          }
        }

        return maybeConvertedRule
      }),
      beforeFiles,
    },
  }
}
