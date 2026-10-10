// Netlify Cache Handler for adapter mode
// (CJS format because Next.js doesn't support ESM yet)
//
// Adapter mode runs Next.js in minimal mode, where the response cache never reads or writes pages
// or routes through the incremental cache (prerender groups are stored by the server handler), so
// the only entries left are `FETCH` ones: `fetch` with `next.revalidate` or `next.tags`, and
// `unstable_cache`. Next.js decides what a stale entry means itself: a render whose result is
// cached waits for fresh data, other renders serve it stale and refetch in the background.

import type { Span } from '@netlify/otel/opentelemetry'

import {
  type CacheHandlerContext,
  type CacheHandlerForMultipleVersions,
  type NetlifyCacheHandlerValue,
} from '../../shared/cache-types.cjs'
import {
  getMemoizedKeyValueStoreBackedByRegionalBlobStore,
  MemoizedKeyValueStoreBackedByRegionalBlobStore,
} from '../storage/storage.cjs'

import { getLogger } from './request-context.cjs'
import {
  isAnyTagStaleOrExpired,
  markTagsAsStaleAndPurgeEdgeCache,
  type RevalidateTagDurations,
} from './tags-handler.cjs'
import { getTracer, recordWarning, withActiveSpan } from './tracer.cjs'

// concurrent renders in one instance write the same entry once
const pendingSets = new Map<string, Promise<void>>()

export class NetlifyAdapterCacheHandler implements CacheHandlerForMultipleVersions {
  revalidatedTags: string[]
  cacheStore: MemoizedKeyValueStoreBackedByRegionalBlobStore
  tracer = getTracer()

  constructor(options: CacheHandlerContext) {
    this.revalidatedTags = options.revalidatedTags
    this.cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })
  }

  async get(
    ...args: Parameters<CacheHandlerForMultipleVersions['get']>
  ): ReturnType<CacheHandlerForMultipleVersions['get']> {
    return withActiveSpan(this.tracer, 'get cache key', async (span) => {
      const [key, context = {}] = args
      // adapter mode needs a Next.js version that passes `kind` (not the older `kindHint`)
      const { kind } = context as { kind?: string }
      span?.setAttributes({ key, kind })

      if (kind !== 'FETCH') {
        recordWarning(
          new Error(`Unexpected cache kind "${kind}" for "${key}", treated as a miss`),
          span,
        )
        return null
      }

      try {
        await pendingSets.get(key)

        const blob = await this.cacheStore.get<NetlifyCacheHandlerValue>(key, 'blobStore.get')
        if (blob?.value?.kind !== 'FETCH') {
          span?.addEvent('Cache miss', { key })
          return null
        }

        const tags = [...(context.tags ?? []), ...(context.softTags ?? [])]
        if (this.revalidatedTags?.some((tag) => tags.includes(tag))) {
          span?.addEvent('Revalidated in this request', { key })
          return null
        }

        const { stale, expired } = await isAnyTagStaleOrExpired(tags, blob.lastModified)
        if (expired) {
          span?.addEvent('Expired', { key })
          return null
        }

        span?.addEvent(stale ? 'Stale' : 'Hit', { key, lastModified: blob.lastModified })
        return {
          // Next.js compares the age with the entry's `revalidate`, so this makes it stale
          lastModified: stale ? -1 : blob.lastModified,
          value: blob.value,
        }
      } catch (error) {
        // a storage failure shouldn't fail the render, Next.js fetches instead
        getLogger().withError(error).error('[NetlifyAdapterCacheHandler.get] error')
        return null
      }
    })
  }

  async set(...args: Parameters<CacheHandlerForMultipleVersions['set']>) {
    return withActiveSpan(this.tracer, 'set cache key', async (span?: Span) => {
      const [key, data] = args
      span?.setAttributes({ key, kind: data?.kind })

      if (data?.kind !== 'FETCH') {
        recordWarning(
          new Error(`Unexpected cache kind "${data?.kind}" for "${key}", not stored`),
          span,
        )
        return
      }

      const concurrentSet = pendingSets.get(key)
      if (concurrentSet) {
        await concurrentSet
        return
      }

      const pendingSet = this.cacheStore
        .set(key, { lastModified: Date.now(), value: data }, 'blobStore.set')
        .then(
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          () => {},
          (error) => getLogger().withError(error).error('[NetlifyAdapterCacheHandler.set] error'),
        )
        .finally(() => pendingSets.delete(key))
      pendingSets.set(key, pendingSet)
      await pendingSet
    })
  }

  async revalidateTag(tagOrTags: string | string[], durations?: RevalidateTagDurations) {
    return markTagsAsStaleAndPurgeEdgeCache(tagOrTags, durations)
  }

  resetRequestCache() {
    // no-op because in-memory cache is scoped to requests and not global
    // see getRequestSpecificInMemoryCache
  }
}

export default NetlifyAdapterCacheHandler
