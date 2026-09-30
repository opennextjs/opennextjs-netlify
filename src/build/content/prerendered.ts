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

import { encodeBlobKey } from '../../shared/blobkey.js'
import type {
  CachedFetchValueForMultipleVersions,
  NetlifyCachedAppPageValue,
  NetlifyCachedPageValue,
  NetlifyCachedRouteValue,
  NetlifyCacheHandlerValue,
  NetlifyIncrementalCacheValue,
} from '../../shared/cache-types.cjs'
import {
  getOwnerSourceRoute,
  getRouteCacheKey,
  ROUTE_CACHE_KEY_NEXT_VERSION_RANGE,
  type RouteCacheKind,
} from '../../shared/route-cache-key.cjs'
import type { PluginContext } from '../plugin-context.js'
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

/**
 * Strip a leading i18n locale segment from a route, mirroring Next's `normalizeLocalePath`. The route
 * that owns an i18n entry is locale-agnostic (Next scopes the key by the locale-stripped source
 * route), while prerender manifest entries and `getFallbacks` are locale-prefixed. `/de/blog/x` ->
 * `/blog/x`, `/de` -> `/`; a route without a known locale prefix is returned unchanged.
 */
const stripLocalePrefix = (route: string, locales: string[]): string => {
  const withLeadingSlash = route.startsWith('/') ? route : `/${route}`
  for (const locale of locales) {
    if (withLeadingSlash === `/${locale}`) {
      return '/'
    }
    if (withLeadingSlash.startsWith(`/${locale}/`)) {
      return withLeadingSlash.slice(locale.length + 1)
    }
  }
  return withLeadingSlash
}

/**
 * Blob key to seed a prerendered entry under. On patched Next this is the route-scoped cache key; on
 * older Next it's the plain file-path key.
 */
const getSeedBlobKey = ({
  route,
  kind,
  sourceRoute,
  useRouteCacheKey,
}: {
  route: string
  kind: RouteCacheKind
  /** Source route without the App Router segment suffix; see `getOwnerSourceRoute`. */
  sourceRoute: string
  useRouteCacheKey: boolean
}): string => {
  if (!useRouteCacheKey) {
    return routeToFilePath(route)
  }
  return getRouteCacheKey(route, { kind, sourceRoute: getOwnerSourceRoute(sourceRoute, kind) })
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

      // From 15.5.27 / 16.3.8 the incremental cache scopes every response cache key by the route that
      // owns the entry before handing it to a custom cache handler. Older Next passes the handler a
      // plain pathname. When the running Next scopes keys we must seed prerendered blobs under the same
      // scoped key, otherwise every entry misses at runtime and re-renders on first request.
      // https://github.com/vercel/next.js/commit/719e4c67d6e92df60246f95e1d96e2dd60789a52
      const useRouteCacheKey = ctx.nextVersion
        ? satisfies(ctx.nextVersion, ROUTE_CACHE_KEY_NEXT_VERSION_RANGE, {
            includePrerelease: true,
          })
        : false

      // i18n entries are locale-prefixed in the manifest, but Next scopes their cache key by the
      // locale-stripped source route, so we strip the locale when deriving `sourceRoute`.
      const locales = ctx.buildConfig.i18n?.locales ?? []

      let appRouterNotFoundDefinedInPrerenderManifest = false

      await Promise.all([
        ...Object.entries(manifest.routes).map(
          ([route, prerenderManifestRoute]): Promise<void> =>
            limitConcurrentPrerenderContentHandling(async () => {
              const lastModified = prerenderManifestRoute.initialRevalidateSeconds
                ? Date.now() - prerenderManifestRoute.initialRevalidateSeconds * 1000
                : Date.now()
              // `key` is the on-disk file-path key for reading the build output (unchanged); the blob
              // is written under `blobKey`, which is route-scoped on patched Next (see getSeedBlobKey).
              const key = routeToFilePath(route)
              let value: NetlifyIncrementalCacheValue
              let cacheKind: RouteCacheKind
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
                  cacheKind = 'PAGES'
                  break
                case prerenderManifestRoute.dataRoute?.endsWith('.rsc'):
                  value = await buildAppCacheValue(
                    join(ctx.publishDir, 'server/app', key),
                    prerenderManifestRoute,
                    shouldUseAppPageKind,
                    prerenderManifestRoute.renderingMode !== 'PARTIALLY_STATIC',
                  )
                  cacheKind = 'APP_PAGE'
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
                  cacheKind = 'APP_ROUTE'
                  break
                default:
                  throw new Error(`Unrecognized content: ${route}`)
              }

              // Netlify Forms are not support and require a workaround
              if (value.kind === 'PAGE' || value.kind === 'PAGES' || value.kind === 'APP_PAGE') {
                verifyNetlifyForms(ctx, value.html)
              }

              const blobKey = getSeedBlobKey({
                route,
                kind: cacheKind,
                sourceRoute: prerenderManifestRoute.srcRoute ?? stripLocalePrefix(route, locales),
                useRouteCacheKey,
              })

              await writeCacheEntry(blobKey, value, lastModified, ctx)
            }),
        ),
        ...ctx.getFallbacks(manifest).map((route) =>
          limitConcurrentPrerenderContentHandling(async () => {
            const key = routeToFilePath(route)
            const value = await buildPagesCacheValue(
              join(ctx.publishDir, 'server/pages', key),
              undefined,
              shouldUseEnumKind,
              true, // there is no corresponding json file for fallback, so we are skipping it for this entry
            )

            // A fallback is the dynamic route's own shell, so it owns itself as the source route.
            const blobKey = getSeedBlobKey({
              route,
              kind: 'PAGES',
              sourceRoute: stripLocalePrefix(route, locales),
              useRouteCacheKey,
            })

            await writeCacheEntry(blobKey, value, Date.now(), ctx)
          }),
        ),
        ...ctx.getShells(manifest).map((route) =>
          limitConcurrentPrerenderContentHandling(async () => {
            const key = routeToFilePath(route)
            const value = await buildAppCacheValue(
              join(ctx.publishDir, 'server/app', key),
              undefined,
              shouldUseAppPageKind,
              // shells always have `renderingMode === 'PARTIALLY_STATIC'`
              false,
            )

            // A shell is the dynamic route's own PPR shell, so it owns itself as the source route.
            const blobKey = getSeedBlobKey({
              route,
              kind: 'APP_PAGE',
              sourceRoute: stripLocalePrefix(route, locales),
              useRouteCacheKey,
            })

            await writeCacheEntry(blobKey, value, Date.now(), ctx)
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
        const blobKey = getSeedBlobKey({
          route: key,
          kind: 'APP_PAGE',
          sourceRoute: key,
          useRouteCacheKey,
        })
        await writeCacheEntry(blobKey, value, lastModified, ctx)
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
