import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { trace } from '@opentelemetry/api'
import { wrapTracer } from '@opentelemetry/api/experimental'
import { glob } from 'fast-glob'
import type { PrerenderManifestRoute } from 'next-with-cache-handler-v2/dist/build/index.js'
import type { RouteMetadata } from 'next-with-cache-handler-v2/dist/export/routes/types.js'
import pLimit from 'p-limit'
import { satisfies } from 'semver'

import {
  getPrerenderFallbackBlobKey,
  getPrerenderGroupBlobKey,
  getPrerenderGroupTags,
  type PrerenderGroupBlob,
} from '../../shared/blob-types.cjs'
import { encodeBlobKey } from '../../shared/blobkey.js'
import type {
  CachedFetchValueForMultipleVersions,
  NetlifyCachedAppPageValue,
  NetlifyCachedPageValue,
  NetlifyCachedRouteValue,
  NetlifyCacheHandlerValue,
  NetlifyIncrementalCacheValue,
} from '../../shared/cache-types.cjs'
import type { PluginContext, PluginContextAdapter } from '../plugin-context.js'
import { verifyNetlifyForms } from '../verification.js'

const tracer = wrapTracer(trace.getTracer('Next runtime'))

/**
 * Write a cache entry to the blob upload directory.
 */
const writeCacheEntry = async (
  route: string,
  value: NetlifyIncrementalCacheValue,
  lastModified: number,
  ctx: PluginContext,
): Promise<void> => {
  const path = join(ctx.blobDir, await encodeBlobKey(route))
  const entry = JSON.stringify({
    lastModified,
    value,
  } satisfies NetlifyCacheHandlerValue)

  await writeFile(path, entry, 'utf-8')
}

/**
 * Normalize routes by ensuring leading slashes and ensuring root path is /index
 */
const routeToFilePath = (path: string) => {
  if (path === '/') {
    return '/index'
  }

  if (path.startsWith('/')) {
    return path
  }

  return `/${path}`
}

function prerenderManifestRouteToRevalidateAndCacheControlProperties(
  prerenderManifestRoute: PrerenderManifestRoute | undefined,
) {
  if (!prerenderManifestRoute) {
    return {}
  }

  return {
    revalidate: prerenderManifestRoute.initialRevalidateSeconds,
    cacheControl: prerenderManifestRoute.initialRevalidateSeconds
      ? {
          revalidate: prerenderManifestRoute.initialRevalidateSeconds,
          expire:
            typeof prerenderManifestRoute.initialExpireSeconds === 'number'
              ? prerenderManifestRoute.initialExpireSeconds +
                (prerenderManifestRoute.initialExpireSeconds ===
                prerenderManifestRoute.initialRevalidateSeconds
                  ? 31536000000
                  : 0)
              : undefined,
        }
      : undefined,
  }
}

const buildPagesCacheValue = async (
  path: string,
  prerenderManifestRoute: PrerenderManifestRoute | undefined,
  shouldUseEnumKind: boolean,
  shouldSkipJson = false,
): Promise<NetlifyCachedPageValue> => ({
  kind: shouldUseEnumKind ? 'PAGES' : 'PAGE',
  html: await readFile(`${path}.html`, 'utf-8'),
  pageData: shouldSkipJson ? {} : JSON.parse(await readFile(`${path}.json`, 'utf-8')),
  headers: undefined,
  status: undefined,
  ...prerenderManifestRouteToRevalidateAndCacheControlProperties(prerenderManifestRoute),
})

const RSC_SEGMENTS_DIR_SUFFIX = '.segments'
const RSC_SEGMENT_SUFFIX = '.segment.rsc'

const buildAppCacheValue = async (
  path: string,
  prerenderManifestRoute: PrerenderManifestRoute | undefined,
  shouldUseAppPageKind: boolean,
  rscIsRequired = true,
): Promise<NetlifyCachedAppPageValue | NetlifyCachedPageValue> => {
  const meta = JSON.parse(await readFile(`${path}.meta`, 'utf-8')) as RouteMetadata
  const html = await readFile(`${path}.html`, 'utf-8')

  // supporting both old and new cache kind for App Router pages - https://github.com/vercel/next.js/pull/65988
  if (shouldUseAppPageKind) {
    // segments are normalized and outputted separately for each segment, we denormalize it here and stitch
    // fully constructed segmentData to avoid data fetch waterfalls later in cache handler at runtime
    // https://github.com/vercel/next.js/blob/def2c6ba75dff754767379afb44c26c30bd3d96b/packages/next/src/server/lib/incremental-cache/file-system-cache.ts#L185
    let segmentData: NetlifyCachedAppPageValue['segmentData']
    if (meta.segmentPaths) {
      const segmentsDir = path + RSC_SEGMENTS_DIR_SUFFIX

      segmentData = Object.fromEntries(
        await Promise.all(
          meta.segmentPaths.map(async (segmentPath: string) => {
            const segmentDataFilePath = segmentsDir + segmentPath + RSC_SEGMENT_SUFFIX

            const segmentContent = await readFile(segmentDataFilePath, 'base64')
            return [segmentPath, segmentContent]
          }),
        ),
      )
    }

    return {
      kind: 'APP_PAGE',
      html,
      rscData: await readFile(`${path}.rsc`, 'base64')
        .catch(() => readFile(`${path}.prefetch.rsc`, 'base64'))
        .catch((error) => {
          if (rscIsRequired) {
            throw error
          }
          // disabling unicorn/no-useless-undefined because we need to return undefined explicitly to satisfy types
          // eslint-disable-next-line unicorn/no-useless-undefined
          return undefined
        }),
      segmentData,
      ...meta,
      ...prerenderManifestRouteToRevalidateAndCacheControlProperties(prerenderManifestRoute),
    }
  }

  const rsc = await readFile(`${path}.rsc`, 'utf-8').catch(() =>
    readFile(`${path}.prefetch.rsc`, 'utf-8'),
  )

  // Next < v14.2.0 does not set meta.status when notFound() is called directly on a page
  // Exclude Parallel routes, they are 404s when visited directly
  if (
    !meta.status &&
    rsc.includes('NEXT_NOT_FOUND') &&
    !(
      typeof meta.headers?.['x-next-cache-tags'] === 'string' &&
      meta.headers?.['x-next-cache-tags'].includes('/@')
    )
  ) {
    meta.status = 404
  }
  return {
    kind: 'PAGE',
    html,
    pageData: rsc,
    ...meta,
    ...prerenderManifestRouteToRevalidateAndCacheControlProperties(prerenderManifestRoute),
  }
}

const buildRouteCacheValue = async (
  path: string,
  prerenderManifestRoute: PrerenderManifestRoute,
  shouldUseEnumKind: boolean,
): Promise<NetlifyCachedRouteValue> => ({
  kind: shouldUseEnumKind ? 'APP_ROUTE' : 'ROUTE',
  body: await readFile(`${path}.body`, 'base64'),
  ...JSON.parse(await readFile(`${path}.meta`, 'utf-8')),
  ...prerenderManifestRouteToRevalidateAndCacheControlProperties(prerenderManifestRoute),
})

const buildFetchCacheValue = async (
  path: string,
): Promise<{ value: CachedFetchValueForMultipleVersions; lastModified: number }> => {
  const data = JSON.parse(await readFile(path, 'utf-8')) as Omit<
    CachedFetchValueForMultipleVersions,
    'kind'
  >

  return {
    value: {
      kind: 'FETCH',
      ...data,
    },
    lastModified: Date.now() - (data?.revalidate ?? 31536000000),
  }
}

/**
 * Upload prerendered content to the blob store
 */
export const copyPrerenderedContent = async (ctx: PluginContext): Promise<void> => {
  return tracer.withActiveSpan('copyPrerenderedContent', async () => {
    try {
      // ensure the blob directory exists
      await mkdir(ctx.blobDir, { recursive: true })
      // read prerendered content and build JSON key/values for the blob store
      const manifest = await ctx.getPrerenderManifest()

      const limitConcurrentPrerenderContentHandling = pLimit(10)

      // https://github.com/vercel/next.js/pull/65988 introduced Cache kind specific to pages in App Router (`APP_PAGE`).
      // Before this change there was common kind for both Pages router and App router pages
      // so we check Next.js version to decide how to generate cache values for App Router pages.
      // Note: at time of writing this code, released 15@rc uses old kind for App Router pages, while 15.0.0@canary.13 and newer canaries use new kind.
      // Looking at 15@rc release branch it was merging `canary` branch in, so the version constraint assumes that future 15@rc (and 15@latest) versions
      // will use new kind for App Router pages.
      const shouldUseAppPageKind = ctx.nextVersion
        ? satisfies(ctx.nextVersion, '>=15.0.0-canary.13 <15.0.0-d || >15.0.0-rc.0', {
            includePrerelease: true,
          })
        : false

      // https://github.com/vercel/next.js/pull/68602 changed the cache kind for Pages router pages from `PAGE` to `PAGES` and from `ROUTE` to `APP_ROUTE`.
      const shouldUseEnumKind = ctx.nextVersion
        ? satisfies(ctx.nextVersion, '>=15.0.0-canary.114 <15.0.0-d || >15.0.0-rc.0', {
            includePrerelease: true,
          })
        : false

      let appRouterNotFoundDefinedInPrerenderManifest = false

      await Promise.all([
        ...Object.entries(manifest.routes).map(
          ([route, prerenderManifestRoute]): Promise<void> =>
            limitConcurrentPrerenderContentHandling(async function writeRouteCacheEntry() {
              // Build output is fresh as of the build, the same as `next start`'s file-system
              // cache and as Vercel (`x-vercel-cache: PRERENDER` then `HIT` for the full
              // `revalidate`, measured 2026-09-20). This used to be backdated by `revalidate` so
              // every ISR route regenerated on its first request (#235, guarding against stale
              // build-time fetch data); that guard is now the `fetch-cache` exclusion from the
              // build cache, and the backdating cost a regeneration per route per deploy and threw
              // away route-handler prerenders outright.
              const lastModified = Date.now()
              const key = routeToFilePath(route)
              let value: NetlifyIncrementalCacheValue
              switch (true) {
                // Parallel route default layout has no prerendered page
                case prerenderManifestRoute.dataRoute?.endsWith('/default.rsc') &&
                  !existsSync(join(ctx.publishDir, 'server/app', `${key}.html`)):
                  return
                case prerenderManifestRoute.dataRoute?.endsWith('.json'):
                  if (manifest.notFoundRoutes.includes(route)) {
                    // if pages router returns 'notFound: true', build won't produce html and json files
                    return
                  }
                  value = await buildPagesCacheValue(
                    join(ctx.publishDir, 'server/pages', key),
                    prerenderManifestRoute,
                    shouldUseEnumKind,
                  )
                  break
                case prerenderManifestRoute.dataRoute?.endsWith('.rsc'):
                  value = await buildAppCacheValue(
                    join(ctx.publishDir, 'server/app', key),
                    prerenderManifestRoute,
                    shouldUseAppPageKind,
                    prerenderManifestRoute.renderingMode !== 'PARTIALLY_STATIC',
                  )
                  if (route === '/_not-found') {
                    appRouterNotFoundDefinedInPrerenderManifest = true
                  }
                  break
                case prerenderManifestRoute.dataRoute === null:
                  value = await buildRouteCacheValue(
                    join(ctx.publishDir, 'server/app', key),
                    prerenderManifestRoute,
                    shouldUseEnumKind,
                  )
                  break
                default:
                  throw new Error(`Unrecognized content: ${route}`)
              }

              // Netlify Forms are not support and require a workaround
              if (value.kind === 'PAGE' || value.kind === 'PAGES' || value.kind === 'APP_PAGE') {
                verifyNetlifyForms(ctx, value.html)
              }

              await writeCacheEntry(key, value, lastModified, ctx)
            }),
        ),
        ...ctx.getFallbacks(manifest).map((route) =>
          limitConcurrentPrerenderContentHandling(async function writeFallbackCacheEntry() {
            const key = routeToFilePath(route)
            const value = await buildPagesCacheValue(
              join(ctx.publishDir, 'server/pages', key),
              undefined,
              shouldUseEnumKind,
              true, // there is no corresponding json file for fallback, so we are skipping it for this entry
            )

            await writeCacheEntry(key, value, Date.now(), ctx)
          }),
        ),
        ...ctx.getShells(manifest).map((route) =>
          limitConcurrentPrerenderContentHandling(async function writeShellCacheEntry() {
            const key = routeToFilePath(route)
            const value = await buildAppCacheValue(
              join(ctx.publishDir, 'server/app', key),
              undefined,
              shouldUseAppPageKind,
              // shells always have `renderingMode === 'PARTIALLY_STATIC'`
              false,
            )

            await writeCacheEntry(key, value, Date.now(), ctx)
          }),
        ),
      ])

      // app router 404 pages are not in the prerender manifest for some next.js versions
      // so we need to check for them manually if prerender manifest does not include it
      if (
        !appRouterNotFoundDefinedInPrerenderManifest &&
        existsSync(join(ctx.publishDir, `server/app/_not-found.html`))
      ) {
        const lastModified = Date.now()
        const key = '/404'
        const value = await buildAppCacheValue(
          join(ctx.publishDir, 'server/app/_not-found'),
          undefined,
          shouldUseAppPageKind,
        )
        await writeCacheEntry(key, value, lastModified, ctx)
      }
    } catch (error) {
      ctx.failBuild('Failed assembling prerendered content for upload', error)
    }
  })
}

/**
 * Upload fetch content to the blob store
 */
export const copyFetchContent = async (ctx: PluginContext): Promise<void> => {
  try {
    const paths = await glob(['!(*.*)'], {
      cwd: join(ctx.publishDir, 'cache/fetch-cache'),
      extglob: true,
    })

    await Promise.all(
      paths.map(async (key): Promise<void> => {
        const path = join(ctx.publishDir, 'cache/fetch-cache', key)
        const { value, lastModified } = await buildFetchCacheValue(path)
        await writeCacheEntry(key, value, lastModified, ctx)
      }),
    )
  } catch (error) {
    ctx.failBuild('Failed assembling fetch content for upload', error)
  }
}

/**
 * A route's fallback that is complete enough to serve as is while a path is generated: the Pages
 * Router `fallback: true` shell. PPR shells (postponed state) need a resume and are not.
 */
export const isFallbackShell = (
  output: Pick<
    PluginContextAdapter['adapterOutput']['outputs']['prerenders'][number],
    'routeType' | 'response' | 'compute' | 'fallback'
  >,
) =>
  output.routeType === 'fallback' &&
  output.response === 'initial' &&
  output.compute === 'static' &&
  Boolean(output.fallback?.filePath) &&
  !output.fallback?.postponedState

/**
 * Seed one blob per prerender group from the adapter output fallbacks (groups with params, like
 * `/posts/[id]`, have none and are filled at runtime).
 */
export const copyPrerenderGroups = async (ctx: PluginContextAdapter): Promise<void> => {
  return tracer.withActiveSpan('copyPrerenderGroups', async () => {
    await mkdir(ctx.blobDir, { recursive: true })
    const { prerenders } = ctx.adapterOutput.outputs
    const lastModified = Date.now()

    await Promise.all(
      prerenders
        .filter((entry) => entry.routeType !== undefined && entry.fallback?.filePath)
        .filter((entry) => !entry.config.allowQuery?.length || isFallbackShell(entry))
        .map(async (entry) => {
          const isShell = Boolean(entry.config.allowQuery?.length)
          const revalidate = entry.fallback?.initialRevalidate ?? false
          const expire = entry.fallback?.initialExpiration
          const cacheControl =
            revalidate === false
              ? 's-maxage=31536000'
              : `s-maxage=${revalidate}, stale-while-revalidate=${(expire ?? 31536000) - revalidate}`

          const group: PrerenderGroupBlob = {
            lastModified,
            revalidate,
            expire,
            tags: [],
            variants: {},
          }
          for (const member of prerenders) {
            if (
              member.groupId !== entry.groupId ||
              !member.fallback?.filePath ||
              (isShell && member !== entry)
            ) {
              continue
            }
            const headers: Record<string, string> = { 'cache-control': cacheControl }
            for (const [key, value] of Object.entries(member.fallback.initialHeaders ?? {})) {
              headers[key] = Array.isArray(value) ? value.join(', ') : value
            }
            const body = await readFile(member.fallback.filePath)
            group.variants[member.pathname] = {
              status: member.fallback.initialStatus ?? 200,
              headers,
              body: body.toString('base64'),
            }
          }
          group.postponed = entry.fallback?.postponedState
          group.tags = getPrerenderGroupTags(
            entry.pathname,
            group.variants[entry.pathname]?.headers['x-next-cache-tags'],
          )

          await writeFile(
            join(
              ctx.blobDir,
              await encodeBlobKey(
                (isShell ? getPrerenderFallbackBlobKey : getPrerenderGroupBlobKey)(entry.pathname),
              ),
            ),
            JSON.stringify(group),
            'utf-8',
          )
        }),
    )
  })
}
