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
// Both workarounds below re-verified as still needed against @next/routing@16.3.4.
// this primarily focus on those rules:

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

// with i18n, middleware matchers get a mandatory locale segment ("/:nextInternalLocale((?!_next/)[^/.]{1,})")
// because Next's router adds the default locale to every request before matching. @next/routing does
// too, except for `/api/` requests, so there `api` gets consumed as the locale (a
// "/((?!api|...).*)" exclusion matcher then matches `/api/x` on its remainder, and a `/api/:path*`
// matcher never matches). Let the locale segment match empty exactly where @next/routing skips it.
const I18N_MATCHER_LOCALE_GROUP = '(?:\\/((?!_next\\/)[^/.]{1,}))'
const I18N_MATCHER_LOCALE_GROUP_OR_API = '(?:(?=\\/api\\/)|(?!\\/api\\/)\\/((?!_next\\/)[^/.]{1,}))'
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
      // Next only sets this when middleware and pages coexist; without it the lib matches
      // beforeFiles/afterFiles rewrites against the raw `/_next/data/<buildId>/…json` path, so
      // config rewrites never apply to data requests. Next's router always normalizes data requests
      // to the page path before routing (and the lib denormalizes again before matching outputs).
      shouldNormalizeNextData: true,
      middlewareMatchers: onBuildCompleteAdapterCtx.config.i18n
        ? onBuildCompleteAdapterCtx.routing.middlewareMatchers.map((matcher) => ({
            ...matcher,
            sourceRegex: matcher.sourceRegex.replace(
              I18N_MATCHER_LOCALE_GROUP,
              I18N_MATCHER_LOCALE_GROUP_OR_API,
            ),
          }))
        : onBuildCompleteAdapterCtx.routing.middlewareMatchers,
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

        return maybeConvertedRule
      }),
      beforeFiles,
    },
  }
}
