// Netlify Cache Handler
// (CJS format because Next.js doesn't support ESM yet)
//
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { join as posixJoin } from 'node:path/posix'

import type { Span } from '@netlify/otel/opentelemetry'
import type { PrerenderManifest } from 'next/dist/build/index.js'
// TODO(adapter): figure out how to make this work in adapter integration tests or just use constant
// import { NEXT_CACHE_TAGS_HEADER } from 'next/dist/lib/constants.js'

import {
  type CacheHandlerContext,
  type CacheHandlerForMultipleVersions,
  isCachedPageValue,
  isCachedRouteValue,
  type NetlifyCachedPageValue,
  type NetlifyCachedRouteValue,
  type NetlifyCacheHandlerValue,
  type NetlifyIncrementalCacheValue,
} from '../../shared/cache-types.cjs'
import {
  getMemoizedKeyValueStoreBackedByRegionalBlobStore,
  MemoizedKeyValueStoreBackedByRegionalBlobStore,
} from '../storage/storage.cjs'

import { getLogger, getRequestContext } from './request-context.cjs'
import {
  isAnyTagStaleOrExpired,
  markTagsAsStaleAndPurgeEdgeCache,
  purgeEdgeCache,
  type RevalidateTagDurations,
  type TagStaleOrExpiredStatus,
} from './tags-handler.cjs'
import { getTracer, recordWarning, withActiveSpan } from './tracer.cjs'

const NEXT_CACHE_TAGS_HEADER = `"x-next-cache-tags"`

let memoizedPrerenderManifest: PrerenderManifest

export class NetlifyCacheHandler implements CacheHandlerForMultipleVersions {
  options: CacheHandlerContext
  revalidatedTags: string[]
  cacheStore: MemoizedKeyValueStoreBackedByRegionalBlobStore
  tracer = getTracer()

  constructor(options: CacheHandlerContext) {
    this.options = options
    this.revalidatedTags = options.revalidatedTags
    this.cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })
  }

  private getTTL(blob: NetlifyCacheHandlerValue) {
    if (
      blob.value?.kind === 'FETCH' ||
      blob.value?.kind === 'ROUTE' ||
      blob.value?.kind === 'APP_ROUTE' ||
      blob.value?.kind === 'PAGE' ||
      blob.value?.kind === 'PAGES' ||
      blob.value?.kind === 'APP_PAGE'
    ) {
      const { revalidate } = blob.value

      if (typeof revalidate === 'number') {
        const revalidateAfter = revalidate * 1_000 + blob.lastModified
        return (revalidateAfter - Date.now()) / 1_000
      }
      if (revalidate === false) {
        return 'PERMANENT'
      }
    }

    return 'NOT SET'
  }

  private captureResponseCacheLastModified(
    cacheValue: NetlifyCacheHandlerValue,
    key: string,
    getCacheKeySpan?: Span,
  ) {
    if (cacheValue.value?.kind === 'FETCH') {
      return
    }

    const requestContext = getRequestContext()

    if (!requestContext) {
      // we will not be able to use request context for date header calculation
      // we will fallback to using blobs
      recordWarning(new Error('CacheHandler was called without a request context'), getCacheKeySpan)
      return
    }

    if (requestContext.responseCacheKey && requestContext.responseCacheKey !== key) {
      // if there are multiple response-cache keys, we don't know which one we should use
      // so as a safety measure we will not use any of them and let blobs be used
      // to calculate the date header
      requestContext.responseCacheGetLastModified = undefined
      recordWarning(
        new Error(
          `Multiple response cache keys used in single request: ["${requestContext.responseCacheKey}, "${key}"]`,
        ),
        getCacheKeySpan,
      )

      return
    }

    requestContext.responseCacheKey = key
    if (cacheValue.lastModified) {
      // we store it to use it later when calculating date header
      requestContext.responseCacheGetLastModified = cacheValue.lastModified
    }
  }

  private captureRouteRevalidateAndRemoveFromObject(
    cacheValue: NetlifyCachedRouteValue,
  ): Omit<NetlifyCachedRouteValue, 'revalidate'> {
    const { revalidate, ...restOfRouteValue } = cacheValue

    const requestContext = getRequestContext()
    if (requestContext) {
      requestContext.routeHandlerRevalidate = revalidate
    }

    return restOfRouteValue
  }

  private captureCacheTags(cacheValue: NetlifyIncrementalCacheValue | null, key: string) {
    const requestContext = getRequestContext()

    // Bail if we can't get request context
    if (!requestContext) {
      return
    }

    // Bail if we already have cache tags - `captureCacheTags()` is called on both `CacheHandler.get` and `CacheHandler.set`
    // that's because `CacheHandler.get` might not have a cache value (cache miss or on-demand revalidation) in which case
    // response is generated in blocking way and we need to capture cache tags from the cache value we are setting.
    // If both `CacheHandler.get` and `CacheHandler.set` are called in the same request, we want to use cache tags from
    // first `CacheHandler.get` and not from following `CacheHandler.set` as this is pattern for Stale-while-revalidate behavior
    // and stale response is served while new one is generated.
    if (requestContext.responseCacheTags) {
      return
    }

    // Set cache tags for 404 pages as well so that the content can later be purged
    if (!cacheValue) {
      const cacheTags = [`_N_T_${key === '/index' ? '/' : encodeURI(key)}`]
      requestContext.responseCacheTags = cacheTags
      return
    }

    if (
      cacheValue.kind === 'PAGE' ||
      cacheValue.kind === 'PAGES' ||
      cacheValue.kind === 'APP_PAGE' ||
      cacheValue.kind === 'ROUTE' ||
      cacheValue.kind === 'APP_ROUTE'
    ) {
      if (cacheValue.headers?.[NEXT_CACHE_TAGS_HEADER]) {
        const cacheTags = (cacheValue.headers[NEXT_CACHE_TAGS_HEADER] as string)
          .split(/,|%2c/gi)
          .map(encodeURI)
        requestContext.responseCacheTags = cacheTags
      } else if (
        (cacheValue.kind === 'PAGE' || cacheValue.kind === 'PAGES') &&
        typeof cacheValue.pageData === 'object'
      ) {
        // pages router doesn't have cache tags headers in PAGE cache value
        // so we need to generate appropriate cache tags for it
        // encode here to deal with non ASCII characters in the key

        const cacheTags = [`_N_T_${key === '/index' ? '/' : encodeURI(key)}`]
        requestContext.responseCacheTags = cacheTags
      }
    }
  }

  private async getPrerenderManifest(serverDistDir: string): Promise<PrerenderManifest> {
    if (memoizedPrerenderManifest) {
      return memoizedPrerenderManifest
    }

    const prerenderManifestPath = join(serverDistDir, '..', 'prerender-manifest.json')

    try {
      // @ts-expect-error Starting in 15.4.0-canary.10 loadManifest was relocated (https://github.com/vercel/next.js/pull/78358)
      // eslint-disable-next-line import/no-unresolved, n/no-missing-import
      const { loadManifest } = await import('next/dist/server/load-manifest.external.js')
      memoizedPrerenderManifest = loadManifest(prerenderManifestPath) as PrerenderManifest
    } catch {
      const { loadManifest } = await import('next/dist/server/load-manifest.js')
      memoizedPrerenderManifest = loadManifest(prerenderManifestPath) as PrerenderManifest
    }

    return memoizedPrerenderManifest
  }

  private async injectEntryToPrerenderManifest(
    key: string,
    { revalidate, cacheControl }: Pick<NetlifyCachedPageValue, 'revalidate' | 'cacheControl'>,
  ) {
    if (
      this.options.serverDistDir &&
      (typeof revalidate === 'number' ||
        revalidate === false ||
        typeof cacheControl !== 'undefined')
    ) {
      try {
        const prerenderManifest = await this.getPrerenderManifest(this.options.serverDistDir)
        if (typeof cacheControl !== 'undefined') {
          try {
            // instead of `revalidate` property, we might get `cacheControls` ( https://github.com/vercel/next.js/pull/76207 )
            // then we need to keep track of revalidate values via SharedCacheControls

            // https://github.com/vercel/next.js/pull/80588 renamed shared-cache-controls module
            const { SharedCacheControls } = await import(
              // @ts-expect-error supporting multiple next version, this module is not resolvable with currently used dev dependency
              // eslint-disable-next-line import/no-unresolved, n/no-missing-import
              'next/dist/server/lib/incremental-cache/shared-cache-controls.external.js'
            )
            const sharedCacheControls = new SharedCacheControls(prerenderManifest)
            sharedCacheControls.set(key, cacheControl)
          } catch {
            // attempting to use shared-cache-controls before https://github.com/vercel/next.js/pull/80588 was merged
            const { SharedCacheControls } = await import(
              // @ts-expect-error supporting multiple next version, this module is not resolvable with currently used dev dependency
              // eslint-disable-next-line import/no-unresolved, n/no-missing-import
              'next/dist/server/lib/incremental-cache/shared-cache-controls.js'
            )
            const sharedCacheControls = new SharedCacheControls(prerenderManifest)
            sharedCacheControls.set(key, cacheControl)
          }
        } else if (typeof revalidate === 'number' || revalidate === false) {
          // if we don't get cacheControls, but we still get revalidate, it should mean we are before
          // https://github.com/vercel/next.js/pull/76207
          try {
            const { normalizePagePath } =
              await import('next/dist/shared/lib/page-path/normalize-page-path.js')

            prerenderManifest.routes[key] = {
              experimentalPPR: undefined,
              dataRoute: posixJoin('/_next/data', `${normalizePagePath(key)}.json`),
              srcRoute: null, // FIXME: provide actual source route, however, when dynamically appending it doesn't really matter
              initialRevalidateSeconds: revalidate,
              // Pages routes do not have a prefetch data route.
              prefetchDataRoute: undefined,
            }
          } catch {
            // depending on Next.js version - prerender manifest might not be mutable
            // https://github.com/vercel/next.js/pull/64313
            // if it's not mutable we will try to use SharedRevalidateTimings ( https://github.com/vercel/next.js/pull/64370) instead
            const { SharedRevalidateTimings } =
              await import('next/dist/server/lib/incremental-cache/shared-revalidate-timings.js')
            const sharedRevalidateTimings = new SharedRevalidateTimings(prerenderManifest)
            sharedRevalidateTimings.set(key, revalidate)
          }
        }
      } catch {}
    }
  }

  async get(
    ...args: Parameters<CacheHandlerForMultipleVersions['get']>
  ): ReturnType<CacheHandlerForMultipleVersions['get']> {
    return withActiveSpan(this.tracer, 'get cache key', async (span) => {
      const [key, context = {}] = args
      getLogger().debug(`[NetlifyCacheHandler.get]: ${key}`)

      span?.setAttributes({ key })

      const blob = await this.cacheStore.get<NetlifyCacheHandlerValue>(key, 'blobStore.get')

      // if blob is null then we don't have a cache entry
      if (!blob) {
        span?.addEvent('Cache miss', { key })
        return null
      }

      const ttl = this.getTTL(blob)

      if (getRequestContext()?.isBackgroundRevalidation && typeof ttl === 'number' && ttl < 0) {
        // background revalidation request should allow data that is not yet stale,
        // but opt to discard STALE data, so that Next.js generate fresh response
        span?.addEvent('Discarding stale entry due to SWR background revalidation request', {
          key,
          ttl,
        })
        getLogger()
          .withFields({
            ttl,
            key,
          })
          .debug(
            `[NetlifyCacheHandler.get] Discarding stale entry due to SWR background revalidation request: ${key}`,
          )
        return null
      }

      const { stale: staleByTags, expired: expiredByTags } = await this.checkCacheEntryStaleByTags(
        blob,
        context.tags,
        context.softTags,
      )

      if (expiredByTags) {
        span?.addEvent('Expired', { expiredByTags, key, ttl })
        return null
      }

      this.captureResponseCacheLastModified(blob, key, span)

      if (staleByTags) {
        span?.addEvent('Stale', { staleByTags, key, ttl })
        // note that we modify this after we capture last modified to ensure that Age is correct
        // but we still let Next.js know that entry is stale
        blob.lastModified = -1 // indicate that the entry is stale
      }

      // Next sets a kind/kindHint and fetchUrl for data requests, however fetchUrl was found to be most reliable across versions
      const isDataRequest = Boolean(context.fetchUrl)
      if (!isDataRequest) {
        this.captureCacheTags(blob.value, key)
      }

      switch (blob.value?.kind) {
        case 'FETCH':
          span?.addEvent('FETCH', {
            lastModified: blob.lastModified,
            revalidate: context.revalidate,
            ttl,
          })
          return {
            lastModified: blob.lastModified,
            value: blob.value,
          }

        case 'ROUTE':
        case 'APP_ROUTE': {
          span?.addEvent(blob.value?.kind, {
            lastModified: blob.lastModified,
            status: blob.value.status,
            revalidate: blob.value.revalidate,
            ttl,
          })

          const valueWithoutRevalidate = this.captureRouteRevalidateAndRemoveFromObject(blob.value)

          return {
            lastModified: blob.lastModified,
            value: {
              ...valueWithoutRevalidate,
              body: Buffer.from(valueWithoutRevalidate.body, 'base64'),
            },
          }
        }
        case 'PAGE':
        case 'PAGES': {
          const { revalidate, ...restOfPageValue } = blob.value

          const requestContext = getRequestContext()
          if (requestContext) {
            requestContext.pageHandlerRevalidate = revalidate
          }

          span?.addEvent(blob.value?.kind, { lastModified: blob.lastModified, revalidate, ttl })

          await this.injectEntryToPrerenderManifest(key, blob.value)

          return {
            lastModified: blob.lastModified,
            value: restOfPageValue,
          }
        }
        case 'APP_PAGE': {
          const requestContext = getRequestContext()
          if (requestContext && blob.value?.kind === 'APP_PAGE') {
            requestContext.isCacheableAppPage = true
          }

          const { revalidate, rscData, segmentData, ...restOfPageValue } = blob.value

          span?.addEvent(blob.value?.kind, { lastModified: blob.lastModified, revalidate, ttl })

          await this.injectEntryToPrerenderManifest(key, blob.value)

          return {
            lastModified: blob.lastModified,
            value: {
              ...restOfPageValue,
              rscData: rscData ? Buffer.from(rscData, 'base64') : undefined,
              segmentData: segmentData
                ? new Map(
                    Object.entries(segmentData).map(([segmentPath, base64EncodedSegment]) => [
                      segmentPath,
                      Buffer.from(base64EncodedSegment, 'base64'),
                    ]),
                  )
                : undefined,
            },
          }
        }
        default:
          span?.recordException(new Error(`Unknown cache entry kind: ${blob.value?.kind}`))
      }
      return null
    })
  }

  private transformToStorableObject(
    data: Parameters<CacheHandlerForMultipleVersions['set']>[1],
    context: Parameters<CacheHandlerForMultipleVersions['set']>[2],
  ): NetlifyIncrementalCacheValue | null {
    if (!data) {
      return null
    }

    if (isCachedRouteValue(data)) {
      return {
        ...data,
        revalidate: context.revalidate ?? context.cacheControl?.revalidate,
        cacheControl: context.cacheControl,
        body: data.body.toString('base64'),
      }
    }

    if (isCachedPageValue(data)) {
      return {
        ...data,
        revalidate: context.revalidate ?? context.cacheControl?.revalidate,
        cacheControl: context.cacheControl,
      }
    }

    if (data?.kind === 'APP_PAGE') {
      return {
        ...data,
        revalidate: context.revalidate ?? context.cacheControl?.revalidate,
        cacheControl: context.cacheControl,
        rscData: data.rscData?.toString('base64'),
        segmentData: data.segmentData
          ? Object.fromEntries(
              [...data.segmentData.entries()].map(([segmentPath, base64EncodedSegment]) => [
                segmentPath,
                base64EncodedSegment.toString('base64'),
              ]),
            )
          : undefined,
      }
    }

    return data
  }

  async set(...args: Parameters<CacheHandlerForMultipleVersions['set']>) {
    return withActiveSpan(this.tracer, 'set cache key', async (span?: Span) => {
      const [key, data, context] = args
      const lastModified = Date.now()
      span?.setAttributes({ key, lastModified })

      getLogger().debug(`[NetlifyCacheHandler.set]: ${key}`)

      const value = this.transformToStorableObject(data, context)

      // Next sets a fetchCache and fetchUrl for data requests, however fetchUrl was found to be most reliable across versions
      const isDataReq = Boolean(context.fetchUrl)
      if (!isDataReq) {
        // if previous CacheHandler.get call returned null (page was either never rendered or was on-demand revalidated)
        // and we didn't yet capture cache tags, we try to get cache tags from freshly produced cache value
        this.captureCacheTags(value, key)
      }

      await this.cacheStore.set(key, { lastModified, value }, 'blobStore.set')

      if (data?.kind === 'APP_PAGE') {
        const requestContext = getRequestContext()
        if (requestContext) {
          requestContext.isCacheableAppPage = true
        }
      }

      if ((!data && !isDataReq) || data?.kind === 'PAGE' || data?.kind === 'PAGES') {
        const requestContext = getRequestContext()
        if (requestContext?.didPagesRouterOnDemandRevalidate) {
          // encode here to deal with non ASCII characters in the key
          const tag = `_N_T_${key === '/index' ? '/' : encodeURI(key)}`

          requestContext?.trackBackgroundWork(purgeEdgeCache(tag))
        }
      }
    })
  }

  async revalidateTag(tagOrTags: string | string[], durations?: RevalidateTagDurations) {
    return markTagsAsStaleAndPurgeEdgeCache(tagOrTags, durations)
  }

  resetRequestCache() {
    // no-op because in-memory cache is scoped to requests and not global
    // see getRequestSpecificInMemoryCache
  }

  /**
   * Checks if a cache entry is stale through on demand revalidated tags
   */
  private checkCacheEntryStaleByTags(
    cacheEntry: NetlifyCacheHandlerValue,
    tags: string[] = [],
    softTags: string[] = [],
  ): TagStaleOrExpiredStatus | Promise<TagStaleOrExpiredStatus> {
    let cacheTags: string[] = []

    if (cacheEntry.value?.kind === 'FETCH') {
      cacheTags = [...tags, ...softTags]
    } else if (
      cacheEntry.value?.kind === 'PAGE' ||
      cacheEntry.value?.kind === 'PAGES' ||
      cacheEntry.value?.kind === 'APP_PAGE' ||
      cacheEntry.value?.kind === 'ROUTE' ||
      cacheEntry.value?.kind === 'APP_ROUTE'
    ) {
      cacheTags =
        (cacheEntry.value.headers?.[NEXT_CACHE_TAGS_HEADER] as string)?.split(/,|%2c/gi) || []
    } else {
      return {
        stale: false,
        expired: false,
      }
    }

    // 1. Check if revalidateTags array passed from Next.js contains any of cacheEntry tags
    if (this.revalidatedTags && this.revalidatedTags.length !== 0) {
      // TODO: test for this case
      for (const tag of this.revalidatedTags) {
        if (cacheTags.includes(tag)) {
          return {
            stale: true,
            expired: true,
          }
        }
      }
    }

    // 2. If any in-memory tags don't indicate that any of tags was invalidated
    //    we will check blob store.
    return isAnyTagStaleOrExpired(cacheTags, cacheEntry.lastModified)
  }
}

export default NetlifyCacheHandler
