import { isPromise } from 'node:util/types'

import { LRUCache } from 'lru-cache'

import { type BlobType, isHtmlBlob, isTagManifest } from '../../shared/blob-types.cjs'
import { getRequestContext } from '../handlers/request-context.cjs'
import { recordWarning } from '../handlers/tracer.cjs'

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

const estimateBlobSize = (valueToStore: BlobType | null | Promise<unknown>): number => {
  // very approximate size calculation to avoid expensive exact size calculation
  // inspired by https://github.com/vercel/next.js/blob/ed10f7ed0246fcc763194197eb9beebcbd063162/packages/next/src/server/lib/incremental-cache/file-system-cache.ts#L60-L79
  if (valueToStore === null || isPromise(valueToStore) || isTagManifest(valueToStore)) {
    return 25
  }
  if (isHtmlBlob(valueToStore)) {
    return valueToStore.html.length
  }
  let knownKindFailed = false
  try {
    if (valueToStore.value?.kind === 'FETCH') {
      return valueToStore.value.data.body.length
    }
    if (valueToStore.value?.kind === 'APP_PAGE') {
      return valueToStore.value.html.length + (valueToStore.value.rscData?.length ?? 0)
    }
    if (valueToStore.value?.kind === 'PAGE' || valueToStore.value?.kind === 'PAGES') {
      return valueToStore.value.html.length + JSON.stringify(valueToStore.value.pageData).length
    }
    if (valueToStore.value?.kind === 'ROUTE' || valueToStore.value?.kind === 'APP_ROUTE') {
      return valueToStore.value.body.length
    }
  } catch {
    // size calculation rely on the shape of the value, so if it's not what we expect, we fallback to JSON.stringify
    knownKindFailed = true
  }

  // fallback for not known kinds or known kinds that did fail to calculate size
  // we should also monitor cases when fallback is used because it's not the most efficient way to calculate/estimate size
  // and might indicate need to make adjustments or additions to the size calculation
  recordWarning(
    new Error(
      `Blob size calculation did fallback to JSON.stringify. Kind: KnownKindFailed: ${knownKindFailed}, ${valueToStore.value?.kind ?? 'undefined'}`,
    ),
  )

  return JSON.stringify(valueToStore).length
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

export const getRequestScopedInMemoryCache = (): RequestScopedInMemoryCache => {
  const requestContext = getRequestContext()
  const inMemoryLRUCache = getInMemoryLRUCache()

  return {
    get(key) {
      if (!requestContext) return
      const value = inMemoryLRUCache?.get(`${requestContext.requestID}:${key}`)
      return value === NullValue ? null : value
    },
    set(key, value) {
      if (!requestContext) return
      inMemoryLRUCache?.set(`${requestContext?.requestID}:${key}`, value ?? NullValue)
    },
  }
}
