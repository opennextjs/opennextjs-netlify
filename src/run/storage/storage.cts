// This is storage module that rest of modules should interact with.
// Remaining modules in storage directory are implementation details
// and should not be used directly outside of this directory.
// There is eslint `no-restricted-imports` rule to enforce this.
import { withActiveSpan } from '@netlify/otel'

import { type BlobType } from '../../shared/blob-types.cjs'
import { getTracer } from '../handlers/tracer.cjs'

import { getRegionalBlobStore } from './regional-blob-store.cjs'
import { getRequestScopedInMemoryCache } from './request-scoped-in-memory-cache.cjs'

const encodeBlobKey = async (key: string) => {
  const { encodeBlobKey: encodeBlobKeyImpl } = await import('../../shared/blobkey.js')
  return await encodeBlobKeyImpl(key)
}

export const getMemoizedKeyValueStoreBackedByRegionalBlobStore = (
  ...args: Parameters<typeof getRegionalBlobStore>
) => {
  const store = getRegionalBlobStore(...args)
  const tracer = getTracer()

  return {
    async get<T extends BlobType>(key: string, otelSpanTitle: string): Promise<T | null> {
      const inMemoryCache = getRequestScopedInMemoryCache()

      const memoizedValue = inMemoryCache.get(key)
      if (typeof memoizedValue !== 'undefined') {
        return memoizedValue as T | null | Promise<T | null>
      }

      const blobKey = await encodeBlobKey(key)
      const getPromise = withActiveSpan(tracer, otelSpanTitle, async (span) => {
        span?.setAttributes({ key, blobKey })
        const blob = (await store.get(blobKey, { type: 'json' })) as T | null
        inMemoryCache.set(key, blob)
        span?.addEvent(blob ? 'Hit' : 'Miss')
        return blob
      })
      inMemoryCache.set(key, getPromise)
      return getPromise
    },
    async set(key: string, value: BlobType, otelSpanTitle: string) {
      const inMemoryCache = getRequestScopedInMemoryCache()

      inMemoryCache.set(key, value)

      const blobKey = await encodeBlobKey(key)
      return withActiveSpan(tracer, otelSpanTitle, async (span) => {
        span?.setAttributes({ key, blobKey })
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

// make select methods public
export { setInMemoryCacheMaxSizeFromNextConfig } from './request-scoped-in-memory-cache.cjs'
export { setFetchBeforeNextPatchedIt } from './regional-blob-store.cjs'
