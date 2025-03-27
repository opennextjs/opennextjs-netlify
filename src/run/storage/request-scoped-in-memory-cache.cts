import { LRUCache } from 'lru-cache'

import { type BlobType, estimateBlobSize } from '../../shared/cache-types.cjs'
import { getRequestContext } from '../handlers/request-context.cjs'

// lru-cache types don't like using `null` for values, so we use a symbol to represent it and do conversion
// so it doesn't leak outside
const NullValue = Symbol.for('null-value')
type BlobLRUCache = LRUCache<string, BlobType | typeof NullValue | Promise<BlobType | null>>

const IN_MEMORY_CACHE_MAX_SIZE = Symbol.for('nf-in-memory-cache-max-size')
const IN_MEMORY_LRU_CACHE = Symbol.for('nf-in-memory-lru-cache')
const extendedGlobalThis = globalThis as typeof globalThis & {
  [IN_MEMORY_CACHE_MAX_SIZE]?: number
  [IN_MEMORY_LRU_CACHE]?: BlobLRUCache | null
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

interface RequestScopedInMemoryCache {
  get(key: string): BlobType | null | Promise<BlobType | null> | undefined
  set(key: string, value: BlobType | null | Promise<BlobType | null>): void
}

const noOpInMemoryCache: RequestScopedInMemoryCache = {
  get(): undefined {
    // no-op
  },
  set() {
    // no-op
  },
}

export const getRequestSpecificInMemoryCache = (): RequestScopedInMemoryCache => {
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
