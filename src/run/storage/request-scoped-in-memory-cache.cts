import { isPromise } from 'node:util/types'

import { LRUCache } from 'lru-cache'

import { type BlobType, isHtmlBlob, isTagManifest } from '../../shared/blob-types.cjs'
import { getRequestContext } from '../handlers/request-context.cjs'
import { recordWarning } from '../handlers/tracer.cjs'

// lru-cache types don't like using `null` for values, so we use a symbol to represent it and do conversion
// so it doesn't leak outside
const NullValue = Symbol.for('null-value')
type DataWithEtag = { data: BlobType; etag: string }

const isDataWithEtag = (value: unknown): value is DataWithEtag => {
  return typeof value === 'object' && value !== null && 'data' in value && 'etag' in value
}

type BlobLRUCache = LRUCache<
  string,
  BlobType | typeof NullValue | Promise<BlobType | null> | DataWithEtag
>

const IN_MEMORY_CACHE_MAX_SIZE = Symbol.for('nf-in-memory-cache-max-size')
const IN_MEMORY_LRU_CACHE = Symbol.for('nf-in-memory-lru-cache')
const extendedGlobalThis = globalThis as typeof globalThis & {
  [IN_MEMORY_CACHE_MAX_SIZE]?: number
  [IN_MEMORY_LRU_CACHE]?: {
    /**
     * entries are scoped to request IDs
     */
    perRequest: BlobLRUCache
    /**
     * global cache shared between requests, does not allow immediate re-use, but is used for
     * conditional blob gets with etags and given blob key is first tried in given request.
     * Map values are weak references to avoid this map strongly referencing blobs and allowing
     * GC based on per request LRU cache evictions alone.
     */
    global: Map<string, WeakRef<DataWithEtag>>
  } | null
}

const DEFAULT_FALLBACK_MAX_SIZE = 50 * 1024 * 1024 // 50MB, same as default Next.js config
export function setInMemoryCacheMaxSizeFromNextConfig(size: unknown) {
  if (typeof size === 'number') {
    extendedGlobalThis[IN_MEMORY_CACHE_MAX_SIZE] = size
  }
}

type PositiveNumber = number & { __positive: true }
const isPositiveNumber = (value: unknown): value is PositiveNumber => {
  return typeof value === 'number' && value > 0
}

const BASE_BLOB_SIZE = 25 as PositiveNumber
const BASE_BLOB_WITH_ETAG_SIZE = (BASE_BLOB_SIZE + 34) as PositiveNumber

const estimateBlobKnownTypeSize = (
  valueToStore: BlobType | null | Promise<unknown> | DataWithEtag,
): number | undefined => {
  // very approximate size calculation to avoid expensive exact size calculation
  // inspired by https://github.com/vercel/next.js/blob/ed10f7ed0246fcc763194197eb9beebcbd063162/packages/next/src/server/lib/incremental-cache/file-system-cache.ts#L60-L79
  if (valueToStore === null || isPromise(valueToStore)) {
    return BASE_BLOB_SIZE
  }

  const { data, baseSize } = isDataWithEtag(valueToStore)
    ? { data: valueToStore.data, baseSize: BASE_BLOB_WITH_ETAG_SIZE }
    : { data: valueToStore, baseSize: BASE_BLOB_SIZE }

  if (isTagManifest(data)) {
    return baseSize
  }

  if (isHtmlBlob(data)) {
    return baseSize + data.html.length
  }

  if (data.value?.kind === 'FETCH') {
    return baseSize + data.value.data.body.length
  }
  if (data.value?.kind === 'APP_PAGE') {
    return baseSize + data.value.html.length + (data.value.rscData?.length ?? 0)
  }
  if (data.value?.kind === 'PAGE' || data.value?.kind === 'PAGES') {
    return baseSize + data.value.html.length + JSON.stringify(data.value.pageData).length
  }
  if (data.value?.kind === 'ROUTE' || data.value?.kind === 'APP_ROUTE') {
    return baseSize + data.value.body.length
  }
}

const estimateBlobSize = (
  valueToStore: BlobType | null | Promise<unknown> | DataWithEtag,
): PositiveNumber => {
  let estimatedKnownTypeSize: number | undefined
  let estimateBlobKnownTypeSizeError: unknown
  try {
    estimatedKnownTypeSize = estimateBlobKnownTypeSize(valueToStore)
    if (isPositiveNumber(estimatedKnownTypeSize)) {
      return estimatedKnownTypeSize
    }
  } catch (error) {
    estimateBlobKnownTypeSizeError = error
  }

  // fallback for not known kinds or known kinds that did fail to calculate positive size
  const calculatedSize = JSON.stringify(valueToStore).length

  // we should also monitor cases when fallback is used because it's not the most efficient way to calculate/estimate size
  // and might indicate need to make adjustments or additions to the size calculation
  recordWarning(
    new Error(
      `Blob size calculation did fallback to JSON.stringify. EstimatedKnownTypeSize: ${estimatedKnownTypeSize}, CalculatedSize: ${calculatedSize}, ValueToStore: ${JSON.stringify(valueToStore)}`,
      estimateBlobKnownTypeSizeError ? { cause: estimateBlobKnownTypeSizeError } : undefined,
    ),
  )

  return isPositiveNumber(calculatedSize) ? calculatedSize : BASE_BLOB_SIZE
}

function getInMemoryLRUCache() {
  if (typeof extendedGlobalThis[IN_MEMORY_LRU_CACHE] === 'undefined') {
    const maxSize =
      typeof extendedGlobalThis[IN_MEMORY_CACHE_MAX_SIZE] === 'number'
        ? extendedGlobalThis[IN_MEMORY_CACHE_MAX_SIZE]
        : DEFAULT_FALLBACK_MAX_SIZE

    if (maxSize === 0) {
      extendedGlobalThis[IN_MEMORY_LRU_CACHE] = null
    } else {
      const global = new Map<string, WeakRef<DataWithEtag>>()

      const perRequest = new LRUCache<
        string,
        BlobType | typeof NullValue | Promise<BlobType | null> | DataWithEtag
      >({
        max: 1000,
        maxSize,
        sizeCalculation: (valueToStore) => {
          return estimateBlobSize(valueToStore === NullValue ? null : valueToStore)
        },
      })

      extendedGlobalThis[IN_MEMORY_LRU_CACHE] = {
        perRequest,
        global,
      }
    }
  }
  return extendedGlobalThis[IN_MEMORY_LRU_CACHE]
}

export function clearInMemoryLRUCacheForTesting() {
  extendedGlobalThis[IN_MEMORY_LRU_CACHE] = undefined
}

interface RequestScopedInMemoryCache {
  get(key: string):
    | { conditional: false; currentRequestValue: BlobType | null | Promise<BlobType | null> }
    | {
        conditional: true
        globalValue: BlobType
        etag: string
      }
    | undefined
  set(key: string, value: BlobType | null | Promise<BlobType | null> | DataWithEtag): void
}

export const getRequestScopedInMemoryCache = (): RequestScopedInMemoryCache => {
  const requestContext = getRequestContext()
  const inMemoryLRUCache = getInMemoryLRUCache()

  return {
    get(key) {
      if (!requestContext) return
      try {
        const currentRequestValue = inMemoryLRUCache?.perRequest.get(
          `${requestContext.requestID}:${key}`,
        )
        if (currentRequestValue) {
          return {
            conditional: false,
            currentRequestValue:
              currentRequestValue === NullValue
                ? null
                : isDataWithEtag(currentRequestValue)
                  ? currentRequestValue.data
                  : currentRequestValue,
          }
        }

        const globalEntry = inMemoryLRUCache?.global.get(key)
        if (globalEntry) {
          const derefencedGlobalEntry = globalEntry.deref()
          if (derefencedGlobalEntry) {
            return {
              conditional: true,
              globalValue: derefencedGlobalEntry.data,
              etag: derefencedGlobalEntry.etag,
            }
          }

          // value has been GC'ed so we can cleanup entry from the map as it no longer points to existing value
          inMemoryLRUCache?.global.delete(key)
        }
      } catch (error) {
        // using in-memory store is perf optimization not requirement
        // trying to use optimization should NOT cause crashes
        // so we just record warning and return undefined
        recordWarning(new Error('Failed to get value from memory cache', { cause: error }))
      }
    },
    set(key, value) {
      if (!requestContext) return
      try {
        if (isDataWithEtag(value)) {
          inMemoryLRUCache?.global.set(key, new WeakRef(value))
        }
        inMemoryLRUCache?.perRequest.set(`${requestContext.requestID}:${key}`, value ?? NullValue)
      } catch (error) {
        // using in-memory store is perf optimization not requirement
        // trying to use optimization should NOT cause crashes
        // so we just record warning and return undefined
        recordWarning(new Error('Failed to store value in memory cache', { cause: error }))
      }
    },
  }
}
