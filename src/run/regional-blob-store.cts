import { getDeployStore, GetWithMetadataOptions, Store } from '@netlify/blobs'
import { LRUCache } from 'lru-cache'

import { type BlobType, estimateBlobSize } from '../shared/cache-types.cjs'

import { getRequestContext } from './handlers/request-context.cjs'
import { getTracer } from './handlers/tracer.cjs'

// lru-cache types don't like using `null` for values, so we use a symbol to represent it and do conversion
// so it doesn't leak outside
const NullValue = Symbol.for('null-value')
type BlobLRUCache = LRUCache<string, BlobType | typeof NullValue | Promise<BlobType | null>>

const FETCH_BEFORE_NEXT_PATCHED_IT = Symbol.for('nf-not-patched-fetch')
const IN_MEMORY_CACHE_MAX_SIZE = Symbol.for('nf-in-memory-cache-max-size')
const IN_MEMORY_LRU_CACHE = Symbol.for('nf-in-memory-lru-cache')
const extendedGlobalThis = globalThis as typeof globalThis & {
  [FETCH_BEFORE_NEXT_PATCHED_IT]?: typeof globalThis.fetch
  [IN_MEMORY_CACHE_MAX_SIZE]?: number
  [IN_MEMORY_LRU_CACHE]?: BlobLRUCache | null
}

/**
 * Attempt to extract original fetch in case it was patched by Next.js already
 *
 * @see github.com/vercel/next.js/blob/fa214c74c1d8023098c0e94e57f917ef9f1afd1a/packages/next/src/server/lib/patch-fetch.ts#L986
 */
function attemptToGetOriginalFetch(
  fetch: typeof globalThis.fetch & {
    _nextOriginalFetch?: typeof globalThis.fetch
  },
) {
  return fetch._nextOriginalFetch ?? fetch
}

function forceOptOutOfUsingDataCache(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    return fetch(input, {
      ...init,
      next: {
        ...init?.next,
        // setting next.internal = true should prevent from trying to use data cache
        // https://github.com/vercel/next.js/blob/fa214c74c1d8023098c0e94e57f917ef9f1afd1a/packages/next/src/server/lib/patch-fetch.ts#L174
        // https://github.com/vercel/next.js/blob/fa214c74c1d8023098c0e94e57f917ef9f1afd1a/packages/next/src/server/lib/patch-fetch.ts#L210-L213
        // this is last line of defense in case we didn't manage to get unpatched fetch that will not affect
        // fetch if it's unpatched so it should be safe to apply always if we aren't sure if we use patched fetch

        // @ts-expect-error - this is an internal field that Next.js doesn't add to its global
        // type overrides for RequestInit type (like `next.revalidate` or `next.tags`)
        internal: true,
      },
    })
  }
}

export const setFetchBeforeNextPatchedIt = (fetch: typeof globalThis.fetch) => {
  // we store in globalThis in case we have multiple copies of this module
  // just as precaution

  extendedGlobalThis[FETCH_BEFORE_NEXT_PATCHED_IT] = forceOptOutOfUsingDataCache(
    attemptToGetOriginalFetch(fetch),
  )
}

const fetchBeforeNextPatchedItFallback = forceOptOutOfUsingDataCache(
  attemptToGetOriginalFetch(globalThis.fetch),
)
const getFetchBeforeNextPatchedIt = () =>
  extendedGlobalThis[FETCH_BEFORE_NEXT_PATCHED_IT] ?? fetchBeforeNextPatchedItFallback

const getRegionalBlobStore = (args: GetWithMetadataOptions = {}): Store => {
  return getDeployStore({
    ...args,
    fetch: getFetchBeforeNextPatchedIt(),
    region: process.env.USE_REGIONAL_BLOBS?.toUpperCase() === 'TRUE' ? undefined : 'us-east-2',
  })
}
const DEFAULT_FALLBACK_MAX_SIZE = 50 * 1024 * 1024 // 50MB, same as default Next.js config
export function setInMemoryCacheMaxSizeFromNextConfig(size: unknown) {
  if (typeof size === 'number') {
    extendedGlobalThis[IN_MEMORY_CACHE_MAX_SIZE] = size
  }
}

function getInMemoryLRUCache() {
  if (typeof extendedGlobalThis[IN_MEMORY_LRU_CACHE] === 'undefined') {
    const maxSize =
      typeof extendedGlobalThis[IN_MEMORY_CACHE_MAX_SIZE] === 'number'
        ? extendedGlobalThis[IN_MEMORY_CACHE_MAX_SIZE]
        : DEFAULT_FALLBACK_MAX_SIZE

    extendedGlobalThis[IN_MEMORY_LRU_CACHE] =
      maxSize === 0
        ? null // if user sets 0 in their config, we should honor that and not use in-memory cache
        : new LRUCache<string, BlobType | typeof NullValue | Promise<BlobType | null>>({
            max: 1000,
            maxSize,
            sizeCalculation: (valueToStore) => {
              return estimateBlobSize(valueToStore === NullValue ? null : valueToStore)
            },
          })
  }
  return extendedGlobalThis[IN_MEMORY_LRU_CACHE]
}

interface RequestSpecificInMemoryCache {
  get(key: string): BlobType | null | Promise<BlobType | null> | undefined
  set(key: string, value: BlobType | null | Promise<BlobType | null>): void
}

const noOpInMemoryCache: RequestSpecificInMemoryCache = {
  get(): undefined {
    // no-op
  },
  set() {
    // no-op
  },
}

const getRequestSpecificInMemoryCache = (): RequestSpecificInMemoryCache => {
  const requestContext = getRequestContext()
  if (!requestContext) {
    // Fallback to a no-op store if we can't find request context
    return noOpInMemoryCache
  }

  const inMemoryLRUCache = getInMemoryLRUCache()
  if (inMemoryLRUCache === null) {
    return noOpInMemoryCache
  }

  return {
    get(key) {
      const inMemoryValue = inMemoryLRUCache.get(`${requestContext.requestID}:${key}`)
      if (inMemoryValue === NullValue) {
        return null
      }
      return inMemoryValue
    },
    set(key, value) {
      inMemoryLRUCache.set(`${requestContext.requestID}:${key}`, value ?? NullValue)
    },
  }
}

const encodeBlobKey = async (key: string) => {
  const { encodeBlobKey: encodeBlobKeyImpl } = await import('../shared/blobkey.js')
  return await encodeBlobKeyImpl(key)
}

export const getMemoizedKeyValueStoreBackedByRegionalBlobStore = (
  args: GetWithMetadataOptions = {},
) => {
  const store = getRegionalBlobStore(args)
  const tracer = getTracer()

  return {
    async get<T extends BlobType>(key: string, otelSpanTitle: string): Promise<T | null> {
      const inMemoryCache = getRequestSpecificInMemoryCache()

      const memoizedValue = inMemoryCache.get(key)
      if (typeof memoizedValue !== 'undefined') {
        return memoizedValue as T | null | Promise<T | null>
      }

      const blobKey = await encodeBlobKey(key)
      const getPromise = tracer.withActiveSpan(otelSpanTitle, async (span) => {
        span.setAttributes({ key, blobKey })
        const blob = (await store.get(blobKey, { type: 'json' })) as T | null
        inMemoryCache.set(key, blob)
        span.addEvent(blob ? 'Hit' : 'Miss')
        return blob
      })
      inMemoryCache.set(key, getPromise)
      return getPromise
    },
    async set(key: string, value: BlobType, otelSpanTitle: string) {
      const inMemoryCache = getRequestSpecificInMemoryCache()

      inMemoryCache.set(key, value)

      const blobKey = await encodeBlobKey(key)
      return tracer.withActiveSpan(otelSpanTitle, async (span) => {
        span.setAttributes({ key, blobKey })
        return await store.setJSON(blobKey, value)
      })
    },
  }
}

/**
 * Wrapper around Blobs Store that memoizes the cache entries within context of a request
 * to avoid duplicate requests to the same key and also allowing to read its own writes from
 * memory.
 */
export type MemoizedKeyValueStoreBackedByRegionalBlobStore = ReturnType<
  typeof getMemoizedKeyValueStoreBackedByRegionalBlobStore
>
