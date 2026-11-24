import { Buffer } from 'node:buffer'

import { LRUCache } from 'lru-cache'
import type {
  CacheEntry,
  // only supporting latest variant (https://github.com/vercel/next.js/pull/76687)
  // first released in v15.3.0-canary.13
  CacheHandlerV2,
} from 'next-with-cache-handler-v2/dist/server/lib/cache-handlers/types.js'
import type { CacheHandler as CacheHandlerWithUpdateTag } from 'next-with-cache-handler-v3/dist/server/lib/cache-handlers/types.js'

import { getLogger } from './request-context.cjs'
import {
  getMostRecentTagExpirationTimestamp,
  isAnyTagStaleOrExpired,
  markTagsAsStaleAndPurgeEdgeCache,
  RevalidateTagDurations,
} from './tags-handler.cjs'
import { getTracer, withActiveSpan } from './tracer.cjs'

// Most of this code is copied and adapted from Next.js default 'use cache' handler implementation
// https://github.com/vercel/next.js/blob/84fde91e03918344c5d356986914ab68a5083462/packages/next/src/server/lib/cache-handlers/default.ts
// this includes:
//  - PrivateCacheEntry (with removed `isErrored` and `errorRetryCount` as those are not actually used there) for default use cache handler
//  - Main logic of .get and .set methods (especially for default cache handler which will use in-memory LRU cache)
// Main difference is:
//  - Tag handling - default Next.js implementation handles tags in memory only, but we need to support tag
//    invalidation cross serverless instances, so we do use same persistent storage as we use for response and fetch cache
//    Additionally we do not actually implement refreshTags to update in-memory tag manifest as this operation is blocking
//    and our serverless instances also can handle any page template so implementing it would not have good perf tradeoffs
//  - Addition of tracing

type PendingSets = Map<string, Promise<void>>

type MultiVersionCacheHandler = CacheHandlerV2 & CacheHandlerWithUpdateTag

const LRU_CACHE_GLOBAL_KEY = Symbol.for('nf-use-cache-handler-lru-cache')
const PENDING_SETS_GLOBAL_KEY = Symbol.for('nf-use-cache-handler-pending-sets')
const cacheHandlersSymbol = Symbol.for('@next/cache-handlers')
const extendedGlobalThis = globalThis as typeof globalThis & {
  // Used by Next Runtime to ensure we have single instance of
  //  - LRUCache
  //  - pending sets
  // even if this module gets copied multiple times
  [LRU_CACHE_GLOBAL_KEY]?: CacheHandleLRUCache
  [PENDING_SETS_GLOBAL_KEY]?: PendingSets

  // Used by Next.js to provide implementation of cache handlers
  [cacheHandlersSymbol]?: {
    RemoteCache?: MultiVersionCacheHandler
    DefaultCache?: MultiVersionCacheHandler
  }
}

function getPendingSets(): PendingSets {
  if (extendedGlobalThis[PENDING_SETS_GLOBAL_KEY]) {
    return extendedGlobalThis[PENDING_SETS_GLOBAL_KEY]
  }

  const pendingSets = new Map()
  extendedGlobalThis[PENDING_SETS_GLOBAL_KEY] = pendingSets
  return pendingSets
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const tmpResolvePendingBeforeCreatingAPromise = () => {}

function createUseCacheHandler({
  cacheHandlerName,
  shouldCloneStreamForReturning,
  storageGet,
  storageSet,
}: {
  cacheHandlerName: string
  /**
   * returning entry will cause stream to be consumed
   * so we might need to clone it first if we store cache-entry in memory with stream instance
   * to avoid consuming stream from storage
   */
  shouldCloneStreamForReturning: boolean
  storageGet: (key: string) => CacheEntry | undefined | Promise<CacheEntry | undefined>
  storageSet: (key: string, entry: CacheEntry) => void | Promise<void>
}): MultiVersionCacheHandler {
  return {
    get(cacheKey: string): ReturnType<MultiVersionCacheHandler['get']> {
      return withActiveSpan(
        getTracer(),
        `${cacheHandlerName}.get`,
        async (span): ReturnType<MultiVersionCacheHandler['get']> => {
          getLogger().withFields({ cacheKey }).debug(`[${cacheHandlerName}] get`)
          span?.setAttributes({
            cacheKey,
          })

          const pendingPromise = getPendingSets().get(cacheKey)
          if (pendingPromise) {
            await pendingPromise
          }

          const entry = await storageGet(cacheKey)
          if (!entry) {
            getLogger()
              .withFields({ cacheKey, status: 'MISS' })
              .debug(`[${cacheHandlerName}] get result`)
            span?.setAttributes({
              cacheStatus: 'miss',
            })
            return undefined
          }

          const ttl = (entry.timestamp + entry.revalidate * 1000 - Date.now()) / 1000
          if (ttl < 0) {
            // In-memory caches should expire after revalidate time because it is
            // unlikely that a new entry will be able to be used before it is dropped
            // from the cache.
            getLogger()
              .withFields({ cacheKey, ttl, status: 'STALE' })
              .debug(`[${cacheHandlerName}] get result`)
            span?.setAttributes({
              cacheStatus: 'expired, discarded',
              ttl,
            })
            return undefined
          }

          const { stale, expired } = await isAnyTagStaleOrExpired(entry.tags, entry.timestamp)

          if (expired) {
            getLogger()
              .withFields({ cacheKey, ttl, status: 'EXPIRED BY TAG' })
              .debug(`[${cacheHandlerName}] get result`)

            span?.setAttributes({
              cacheStatus: 'expired tag, discarded',
              ttl,
            })
            return undefined
          }

          let { revalidate, value } = entry
          if (stale) {
            revalidate = -1
          }

          getLogger()
            .withFields({ cacheKey, ttl, status: stale ? 'STALE' : 'HIT' })
            .debug(`[${cacheHandlerName}] get result`)
          span?.setAttributes({
            cacheStatus: stale ? 'stale' : 'hit',
            ttl,
          })

          if (shouldCloneStreamForReturning) {
            // returning entry will cause stream to be consumed
            // so we need to clone it first, so in-memory cache can
            // be used again
            const [returnStream, newSaved] = value.tee()
            // mutate in-memory cache entry to one of tee'd streams as we did just consume its value
            entry.value = newSaved
            // use other tee'd stream for return value
            value = returnStream
          }

          return {
            ...entry,
            revalidate,
            value,
          }
        },
      )
    },
    set(
      cacheKey: string,
      pendingEntry: Promise<CacheEntry>,
    ): ReturnType<MultiVersionCacheHandler['set']> {
      return withActiveSpan(
        getTracer(),
        `${cacheHandlerName}.set`,
        async (span): ReturnType<MultiVersionCacheHandler['set']> => {
          getLogger().withFields({ cacheKey }).debug(`[${cacheHandlerName}] set`)
          span?.setAttributes({
            cacheKey,
          })

          let resolvePending: () => void = tmpResolvePendingBeforeCreatingAPromise
          const pendingPromise = new Promise<void>((resolve) => {
            resolvePending = resolve
          })

          const pendingSets = getPendingSets()

          pendingSets.set(cacheKey, pendingPromise)

          const entry = await pendingEntry

          span?.setAttributes({
            cacheKey,
            tags: entry.tags,
            timestamp: entry.timestamp,
            revalidate: entry.revalidate,
            expire: entry.expire,
          })

          try {
            await storageSet(cacheKey, entry)
          } catch (error) {
            getLogger().withError(error).error(`[${cacheHandlerName}.set] error`)
            if (error instanceof Error) {
              span?.recordException(error)
            }
          } finally {
            resolvePending()
            pendingSets.delete(cacheKey)
          }
        },
      )
    },
    async refreshTags(): Promise<void> {
      // we check tags on demand, so we don't need to do anything here
      // additionally this is blocking and we do need to check tags in
      // persisted storage, so if we would maintain in-memory tags manifests
      // we would need to check more tags than current request needs
      // while blocking pipeline
    },
    getExpiration: function (
      // supporting both (...tags: string[]) and (tags: string[]) signatures
      ...notNormalizedTags: string[] | string[][]
    ): ReturnType<MultiVersionCacheHandler['getExpiration']> {
      return withActiveSpan(
        getTracer(),
        `${cacheHandlerName}.getExpiration`,
        async (span): ReturnType<MultiVersionCacheHandler['getExpiration']> => {
          const tags = notNormalizedTags.flat()

          span?.setAttributes({
            tags,
          })

          const expiration = await getMostRecentTagExpirationTimestamp(tags)

          getLogger().withFields({ tags, expiration }).debug(`[${cacheHandlerName}] getExpiration`)
          span?.setAttributes({
            expiration,
          })

          return expiration
        },
      )
    },
    // this is for CacheHandlerV2
    expireTags(...tags: string[]): ReturnType<MultiVersionCacheHandler['expireTags']> {
      return withActiveSpan(
        getTracer(),
        `${cacheHandlerName}.expireTags`,
        async (span): ReturnType<MultiVersionCacheHandler['expireTags']> => {
          getLogger().withFields({ tags }).debug(`[${cacheHandlerName}] expireTags`)
          span?.setAttributes({
            tags,
          })

          await markTagsAsStaleAndPurgeEdgeCache(tags)
        },
      )
    },
    // this is for CacheHandlerV3 / Next 16
    updateTags(
      tags: string[],
      durations: RevalidateTagDurations,
    ): ReturnType<MultiVersionCacheHandler['updateTags']> {
      return withActiveSpan(
        getTracer(),
        'DefaultUseCacheHandler.updateTags',
        async (span): ReturnType<MultiVersionCacheHandler['updateTags']> => {
          getLogger().withFields({ tags, durations }).debug(`[${cacheHandlerName}] updateTags`)
          span?.setAttributes({
            tags,
            durations: JSON.stringify(durations),
          })
          await markTagsAsStaleAndPurgeEdgeCache(tags, durations)
        },
      )
    },
  } satisfies MultiVersionCacheHandler
}

type PrivateCacheEntry = {
  entry: CacheEntry
  // compute size on set since we need to read size
  // of the ReadableStream for LRU evicting
  size: number
}

type CacheHandleLRUCache = LRUCache<string, PrivateCacheEntry>

function getLRUCache(): CacheHandleLRUCache {
  if (extendedGlobalThis[LRU_CACHE_GLOBAL_KEY]) {
    return extendedGlobalThis[LRU_CACHE_GLOBAL_KEY]
  }

  const lruCache = new LRUCache<string, PrivateCacheEntry>({
    max: 1000,
    maxSize: 50 * 1024 * 1024, // same as hardcoded default in Next.js
    sizeCalculation: (value) => value.size,
  })

  extendedGlobalThis[LRU_CACHE_GLOBAL_KEY] = lruCache

  return lruCache
}

const NetlifyDefaultUseCacheHandler = createUseCacheHandler({
  cacheHandlerName: 'NetlifyDefaultUseCacheHandler',
  // we store ReadableStream in in-memory LRU cache so we must ensure it stays usable
  shouldCloneStreamForReturning: true,
  storageGet: async (cacheKey: string) => {
    return getLRUCache().get(cacheKey)?.entry
  },
  storageSet: async (cacheKey: string, entry: CacheEntry) => {
    let size = 0
    const [value, clonedValue] = entry.value.tee()
    entry.value = value
    const reader = clonedValue.getReader()

    for (let chunk; !(chunk = await reader.read()).done; ) {
      size += Buffer.from(chunk.value).byteLength
    }

    getLRUCache().set(cacheKey, {
      entry,
      size,
    })
  },
})

export function configureUseCacheHandlers() {
  extendedGlobalThis[cacheHandlersSymbol] = {
    DefaultCache: NetlifyDefaultUseCacheHandler,
  }
}
