import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path/posix'

import type { InSourceConfig } from '@netlify/zip-it-and-ship-it/dist/runtimes/node/in_source_config/index.js'
import { glob } from 'fast-glob'

import {
  DISPLAY_NAME_PAGES_AND_APP,
  GENERATOR,
  NETLIFY_FRAMEWORKS_API_FUNCTIONS,
  PLUGIN_DIR,
} from './constants.js'
import type { NetlifyAdapterContext, OnBuildCompleteContext } from './types.js'

const PAGES_AND_APP_FUNCTION_INTERNAL_NAME = 'next_pages_and_app'

const RUNTIME_DIR = '.netlify'

const PAGES_AND_APP_FUNCTION_DIR = join(
  NETLIFY_FRAMEWORKS_API_FUNCTIONS,
  PAGES_AND_APP_FUNCTION_INTERNAL_NAME,
)

// there is some inconsistency with pathnames sometimes being '/' and sometimes being '/index',
// but handler seems to expect '/'
function normalizeIndex(path: string): string {
  if (path === '/index') {
    return '/'
  }

  return path.replace(
    // if Index is getServerSideProps weird things happen:
    // /_next/data/<build-id>/.json is produced instead of /_next/data/<build-id>/index.json
    /^\/_next\/data\/(?<buildId>[^/]+)\/\.json$/,
    '/_next/data/$<buildId>/index.json',
  )
}

const ONE_YEAR = 60 * 60 * 24 * 365

// copied from Next.js packages/next/src/server/lib/cache-control.ts
function getCacheControlHeader({
  revalidate,
  expire,
}: {
  revalidate: number | false
  expire: number | undefined
}): string {
  const swrHeader =
    typeof revalidate === 'number' && expire !== undefined && revalidate < expire
      ? `, stale-while-revalidate=${expire - revalidate}`
      : ''

  if (revalidate === 0) {
    return 'private, no-cache, no-store, max-age=0, must-revalidate'
  }

  if (typeof revalidate === 'number') {
    return `s-maxage=${revalidate}${swrHeader}`
  }

  return `s-maxage=${ONE_YEAR}${swrHeader}`
}

export async function onBuildComplete(
  nextAdapterContext: OnBuildCompleteContext,
  netlifyAdapterContext: NetlifyAdapterContext,
) {
  const requiredFiles = new Set<string>()
  const { isrGroups, endpoints } = netlifyAdapterContext.preparedOutputs

  for (const outputs of [
    nextAdapterContext.outputs.pages,
    nextAdapterContext.outputs.pagesApi,
    nextAdapterContext.outputs.appPages,
    nextAdapterContext.outputs.appRoutes,
  ]) {
    for (const output of outputs) {
      if (output.runtime === 'edge') {
        // TODO: figure something out here
        continue
      }
      for (const asset of Object.values(output.assets)) {
        requiredFiles.add(asset)
      }

      requiredFiles.add(output.filePath)
      endpoints[normalizeIndex(output.pathname)] = {
        entry: relative(nextAdapterContext.repoRoot, output.filePath),
        id: normalizeIndex(output.pathname),
        type: 'function',
      }
    }
  }

  const ONE_YEAR_AGO_DATE = new Date(Date.now() - ONE_YEAR * 1000).toUTCString()
  const NOW_DATE = new Date().toUTCString()

  for (const prerender of nextAdapterContext.outputs.prerenders) {
    const normalizedPathname = normalizeIndex(prerender.pathname)
    const normalizedParentOutputId = normalizeIndex(prerender.parentOutputId)

    const existingEntryForParent = endpoints[normalizedParentOutputId]

    if (existingEntryForParent) {
      endpoints[normalizedPathname] = {
        ...existingEntryForParent,
        id: normalizedPathname,
        type: 'isr',
        isrGroup: prerender.groupId,
      }

      if (!isrGroups[prerender.groupId]) {
        isrGroups[prerender.groupId] = []
      }
      const isrGroup: (typeof isrGroups)[number][number] = {
        pathname: normalizedPathname,
        queryParams: prerender.config.allowQuery ?? [],
      }

      if (prerender.fallback) {
        const normalizedHeaders = prerender.fallback.initialHeaders
          ? Object.fromEntries(
              Object.entries(prerender.fallback.initialHeaders).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(',') : value,
              ]),
            )
          : {}

        normalizedHeaders['cache-control'] = 'public, max-age=0, must-revalidate'
        normalizedHeaders['adapter-cdn-cache-control'] = getCacheControlHeader({
          revalidate: prerender.fallback.initialRevalidate ?? false,
          expire: prerender.fallback.initialExpiration,
        })
        normalizedHeaders.date = prerender.fallback.initialRevalidate ? ONE_YEAR_AGO_DATE : NOW_DATE

        try {
          isrGroup.fallback = {
            content:
              'filePath' in prerender.fallback
                ? await readFile(prerender.fallback.filePath, 'utf-8')
                : undefined,
            status: prerender.fallback.initialStatus,
            headers: normalizedHeaders,
            expiration: prerender.fallback.initialExpiration,
            revalidate: prerender.fallback.initialRevalidate,
            postponedState: prerender.fallback.postponedState,
          }
        } catch (error) {
          const meaningfulError = new Error(
            `Failed to create fallback for:\n${JSON.stringify(prerender, null, 2)}`,
            {
              cause: error,
            },
          )
          console.error(meaningfulError)
        }
      }

      isrGroups[prerender.groupId].push(isrGroup)
    } else {
      console.warn('Could not find parent output for prerender:', {
        pathname: normalizedPathname,
        parentOutputId: normalizedParentOutputId,
      })
    }
  }

  await mkdir(PAGES_AND_APP_FUNCTION_DIR, { recursive: true })

  for (const filePath of requiredFiles) {
    await cp(
      filePath,
      join(PAGES_AND_APP_FUNCTION_DIR, relative(nextAdapterContext.repoRoot, filePath)),
      {
        recursive: true,
      },
    )
  }

  await copyRuntime(join(PAGES_AND_APP_FUNCTION_DIR, RUNTIME_DIR))

  const normalizedPathsForFunctionConfig = Object.keys(endpoints).map((pathname) =>
    pathname.toLowerCase(),
  )

  const functionConfig = {
    path: normalizedPathsForFunctionConfig,
    nodeBundler: 'none',
    includedFiles: ['**'],
    generator: GENERATOR,
    name: DISPLAY_NAME_PAGES_AND_APP,
  } as const satisfies InSourceConfig

  // generate needed runtime files
  const entrypoint = /* javascript */ `
    import { createRequire } from 'node:module'

    import { runHandler } from './${RUNTIME_DIR}/dist/adapter/run/pages-and-app-handler.js'

    const pickedOutputs = ${JSON.stringify({ isrGroups, endpoints }, null, 2)}

    const require = createRequire(import.meta.url)

    export default async function handler(request, context) {
      const response = await runHandler(request, context, pickedOutputs, require)
      console.log('Serving response with status:', response.status)
      return response
    }

    export const config = ${JSON.stringify(functionConfig, null, 2)}
  `
  await writeFile(
    join(PAGES_AND_APP_FUNCTION_DIR, `${PAGES_AND_APP_FUNCTION_INTERNAL_NAME}.mjs`),
    entrypoint,
  )

  // netlifyAdapterContext.preparedOutputs.endpoints.push(...functionConfig.path)
}

const copyRuntime = async (handlerDirectory: string): Promise<void> => {
  const files = await glob('dist/**/*', {
    cwd: PLUGIN_DIR,
    ignore: ['**/*.test.ts'],
    dot: true,
  })
  await Promise.all(
    files.map((path) =>
      cp(join(PLUGIN_DIR, path), join(handlerDirectory, path), { recursive: true }),
    ),
  )
  // We need to create a package.json file with type: module to make sure that the runtime modules
  // are handled correctly as ESM modules
  await writeFile(join(handlerDirectory, 'package.json'), JSON.stringify({ type: 'module' }))
}
