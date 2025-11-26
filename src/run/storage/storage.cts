// This is storage module that rest of modules should interact with.
// Remaining modules in storage directory are implementation details
// and should not be used directly outside of this directory.
// There is eslint `no-restricted-imports` rule to enforce this.

import { type BlobType } from '../../shared/blob-types.cjs'
import { getTracer, withActiveSpan } from '../handlers/tracer.cjs'

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
      if (
        memoizedValue?.conditional === false &&
        typeof memoizedValue?.currentRequestValue !== 'undefined'
      ) {
        return memoizedValue.currentRequestValue as T | null | Promise<T | null>
      }

      const blobKey = await encodeBlobKey(key)
      const getPromise = withActiveSpan(tracer, otelSpanTitle, async (span) => {
        const { etag: previousEtag, globalValue: previousBlob } = memoizedValue?.conditional
          ? memoizedValue
          : {}

        span?.setAttributes({ key, blobKey, previousEtag })

        const result = await store.getWithMetadata(blobKey, {
          type: 'json',
          etag: previousEtag,
          span,
        })

        const shouldReuseMemoizedBlob = result?.etag && previousEtag === result?.etag

        const blob = (shouldReuseMemoizedBlob ? previousBlob : result?.data) as T | null

        if (result?.etag && blob) {
          inMemoryCache.set(key, {
            data: blob,
            etag: result?.etag,
          })
        } else {
          // if we don't get blob (null) or etag for some reason is missing,
          // we still want to store resolved blob value so that it could be reused
          // within the same request
          inMemoryCache.set(key, blob)
        }

        span?.setAttributes({
          etag: result?.etag,
          reusingPreviouslyFetchedBlob: shouldReuseMemoizedBlob,
          status: blob ? (shouldReuseMemoizedBlob ? 'Hit, no change' : 'Hit') : 'Miss',
        })

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
        const writeResult = await store.setJSON(blobKey, value, { span })
        if (writeResult?.etag) {
          inMemoryCache.set(key, {
            data: value,
            etag: writeResult.etag,
          })
        }
        return writeResult
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
