// Netlify Cache Handler
// (CJS format because Next.js doesn't support ESM yet)
//
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { join as posixJoin } from 'node:path/posix'

import { purgeCache } from '@netlify/functions'
import { type Span } from '@opentelemetry/api'
import type { PrerenderManifest } from 'next/dist/build/index.js'
import { NEXT_CACHE_TAGS_HEADER } from 'next/dist/lib/constants.js'

import { name as nextRuntimePkgName, version as nextRuntimePkgVersion } from '../../../package.json'
import { type TagManifest } from '../../shared/blob-types.cjs'
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
import { getTracer, recordWarning } from './tracer.cjs'

const purgeCacheUserAgent = `${nextRuntimePkgName}@${nextRuntimePkgVersion}`

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
    getCacheKeySpan: Span,
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
    if (!cacheValue) {
      return
    }

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

    if (
      cacheValue.kind === 'PAGE' ||
      cacheValue.kind === 'PAGES' ||
      cacheValue.kind === 'APP_PAGE' ||
      cacheValue.kind === 'ROUTE' ||
      cacheValue.kind === 'APP_ROUTE'
    ) {
      if (cacheValue.headers?.[NEXT_CACHE_TAGS_HEADER]) {
        const cacheTags = (cacheValue.headers[NEXT_CACHE_TAGS_HEADER] as string).split(/,|%2c/gi)
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
        const { loadManifest } = await import('next/dist/server/load-manifest.js')
        const prerenderManifest = loadManifest(
          join(this.options.serverDistDir, '..', 'prerender-manifest.json'),
        ) as PrerenderManifest

        if (typeof cacheControl !== 'undefined') {
          // instead of `revalidate` property, we might get `cacheControls` ( https://github.com/vercel/next.js/pull/76207 )
          // then we need to keep track of revalidate values via SharedCacheControls
          const { SharedCacheControls } = await import(
            // @ts-expect-error supporting multiple next version, this module is not resolvable with currently used dev dependency
            // eslint-disable-next-line import/no-unresolved, n/no-missing-import
            'next/dist/server/lib/incremental-cache/shared-cache-controls.js'
          )
          const sharedCacheControls = new SharedCacheControls(prerenderManifest)
          sharedCacheControls.set(key, cacheControl)
        } else if (typeof revalidate === 'number' || revalidate === false) {
          // if we don't get cacheControls, but we still get revalidate, it should mean we are before
          // https://github.com/vercel/next.js/pull/76207
          try {
            const { normalizePagePath } = await import(
              'next/dist/shared/lib/page-path/normalize-page-path.js'
            )

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
            const { SharedRevalidateTimings } = await import(
              'next/dist/server/lib/incremental-cache/shared-revalidate-timings.js'
            )
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
    return this.tracer.withActiveSpan('get cache key', async (span) => {
      const [key, ctx = {}] = args
      getLogger().debug(`[NetlifyCacheHandler.get]: ${key}`)

      span.setAttributes({ key })

      const blob = await this.cacheStore.get<NetlifyCacheHandlerValue>(key, 'blobStore.get')

      // if blob is null then we don't have a cache entry
      if (!blob) {
        span.addEvent('Cache miss', { key })
        return null
      }

      const ttl = this.getTTL(blob)

      if (getRequestContext()?.isBackgroundRevalidation && typeof ttl === 'number' && ttl < 0) {
        // background revalidation request should allow data that is not yet stale,
        // but opt to discard STALE data, so that Next.js generate fresh response
        span.addEvent('Discarding stale entry due to SWR background revalidation request', {
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

      const staleByTags = await this.checkCacheEntryStaleByTags(blob, ctx.tags, ctx.softTags)

      if (staleByTags) {
        span.addEvent('Stale', { staleByTags, key, ttl })
        return null
      }

      this.captureResponseCacheLastModified(blob, key, span)
      this.captureCacheTags(blob.value, key)

      switch (blob.value?.kind) {
        case 'FETCH':
          span.addEvent('FETCH', {
            lastModified: blob.lastModified,
            revalidate: ctx.revalidate,
            ttl,
          })
          return {
            lastModified: blob.lastModified,
            value: blob.value,
          }

        case 'ROUTE':
        case 'APP_ROUTE': {
          span.addEvent(blob.value?.kind, {
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

          span.addEvent(blob.value?.kind, { lastModified: blob.lastModified, revalidate, ttl })

          await this.injectEntryToPrerenderManifest(key, blob.value)

          return {
            lastModified: blob.lastModified,
            value: restOfPageValue,
          }
        }
        case 'APP_PAGE': {
          const { revalidate, rscData, ...restOfPageValue } = blob.value

          span.addEvent(blob.value?.kind, { lastModified: blob.lastModified, revalidate, ttl })

          await this.injectEntryToPrerenderManifest(key, blob.value)

          return {
            lastModified: blob.lastModified,
            value: {
              ...restOfPageValue,
              rscData: rscData ? Buffer.from(rscData, 'base64') : undefined,
            },
          }
        }
        default:
          span.recordException(new Error(`Unknown cache entry kind: ${blob.value?.kind}`))
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
      }
    }

    return data
  }

  async set(...args: Parameters<CacheHandlerForMultipleVersions['set']>) {
    return this.tracer.withActiveSpan('set cache key', async (span) => {
      const [key, data, context] = args
      const lastModified = Date.now()
      span.setAttributes({ key, lastModified })

      getLogger().debug(`[NetlifyCacheHandler.set]: ${key}`)

      const value = this.transformToStorableObject(data, context)

      // if previous CacheHandler.get call returned null (page was either never rendered or was on-demand revalidated)
      // and we didn't yet capture cache tags, we try to get cache tags from freshly produced cache value
      this.captureCacheTags(value, key)

      await this.cacheStore.set(key, { lastModified, value }, 'blobStore.set')

      if (data?.kind === 'PAGE' || data?.kind === 'PAGES') {
        const requestContext = getRequestContext()
        if (requestContext?.didPagesRouterOnDemandRevalidate) {
          // encode here to deal with non ASCII characters in the key
          const tag = `_N_T_${key === '/index' ? '/' : encodeURI(key)}`
          const tags = tag.split(/,|%2c/gi).filter(Boolean)

          if (tags.length === 0) {
            return
          }

          getLogger().debug(`Purging CDN cache for: [${tag}]`)
          requestContext.trackBackgroundWork(
            purgeCache({ tags, userAgent: purgeCacheUserAgent }).catch((error) => {
              // TODO: add reporting here
              getLogger()
                .withError(error)
                .error(`[NetlifyCacheHandler]: Purging the cache for tag ${tag} failed`)
            }),
          )
        }
      }
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async revalidateTag(tagOrTags: string | string[], ...args: any) {
    const revalidateTagPromise = this.doRevalidateTag(tagOrTags, ...args)

    const requestContext = getRequestContext()
    if (requestContext) {
      requestContext.trackBackgroundWork(revalidateTagPromise)
    }

    return revalidateTagPromise
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async doRevalidateTag(tagOrTags: string | string[], ...args: any) {
    getLogger().withFields({ tagOrTags, args }).debug('NetlifyCacheHandler.revalidateTag')

    const tags = (Array.isArray(tagOrTags) ? tagOrTags : [tagOrTags])
      .flatMap((tag) => tag.split(/,|%2c/gi))
      .filter(Boolean)

    if (tags.length === 0) {
      return
    }

    const data: TagManifest = {
      revalidatedAt: Date.now(),
    }

    await Promise.all(
      tags.map(async (tag) => {
        try {
          await this.cacheStore.set(tag, data, 'tagManifest.set')
        } catch (error) {
          getLogger().withError(error).log(`Failed to update tag manifest for ${tag}`)
        }
      }),
    )

    await purgeCache({ tags, userAgent: purgeCacheUserAgent }).catch((error) => {
      // TODO: add reporting here
      getLogger()
        .withError(error)
        .error(`[NetlifyCacheHandler]: Purging the cache for tags ${tags.join(', ')} failed`)
    })
  }

  resetRequestCache() {
    // no-op because in-memory cache is scoped to requests and not global
    // see getRequestSpecificInMemoryCache
  }

  /**
   * Checks if a cache entry is stale through on demand revalidated tags
   */
  private async checkCacheEntryStaleByTags(
    cacheEntry: NetlifyCacheHandlerValue,
    tags: string[] = [],
    softTags: string[] = [],
  ) {
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
      return false
    }

    // 1. Check if revalidateTags array passed from Next.js contains any of cacheEntry tags
    if (this.revalidatedTags && this.revalidatedTags.length !== 0) {
      // TODO: test for this case
      for (const tag of this.revalidatedTags) {
        if (cacheTags.includes(tag)) {
          return true
        }
      }
    }

    // 2. If any in-memory tags don't indicate that any of tags was invalidated
    //    we will check blob store. Full-route cache and fetch caches share a lot of tags
    //    but we will only do actual blob read once withing a single request due to cacheStore
    //    memoization.
    //    Additionally, we will resolve the promise as soon as we find first
    //    stale tag, so that we don't wait for all of them to resolve (but keep all
    //    running in case future `CacheHandler.get` calls would be able to use results).
    //    "Worst case" scenario is none of tag was invalidated in which case we need to wait
    //    for all blob store checks to finish before we can be certain that no tag is stale.
    return new Promise<boolean>((resolve, reject) => {
      const tagManifestPromises: Promise<boolean>[] = []

      for (const tag of cacheTags) {
        const tagManifestPromise: Promise<TagManifest | null> = this.cacheStore.get<TagManifest>(
          tag,
          'tagManifest.get',
        )

        tagManifestPromises.push(
          tagManifestPromise.then((tagManifest) => {
            if (!tagManifest) {
              return false
            }
            const isStale = tagManifest.revalidatedAt >= (cacheEntry.lastModified || Date.now())
            if (isStale) {
              resolve(true)
              return true
            }
            return false
          }),
        )
      }

      // make sure we resolve promise after all blobs are checked (if we didn't resolve as stale yet)
      Promise.all(tagManifestPromises)
        .then((tagManifestAreStale) => {
          resolve(tagManifestAreStale.some((tagIsStale) => tagIsStale))
        })
        .catch(reject)
    })
  }
}

export default NetlifyCacheHandler
