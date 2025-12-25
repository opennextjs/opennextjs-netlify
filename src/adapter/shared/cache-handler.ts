import type {
  CacheHandler,
  CacheHandlerValue,
} from 'next-with-adapters/dist/server/lib/incremental-cache/index.js'
import {
  IncrementalCacheValue,
  SetIncrementalFetchCacheContext,
  SetIncrementalResponseCacheContext,
} from 'next-with-adapters/dist/server/response-cache/types.js'

export default class NetlifyCacheHandler implements CacheHandler {
  async set(
    cacheKey: string,
    data: IncrementalCacheValue | null,
    ctx: SetIncrementalFetchCacheContext | SetIncrementalResponseCacheContext,
  ): Promise<void> {
    console.log('CacheHandler.set', { cacheKey, data, ctx })
  }

  async revalidateTag(tags: string | string[]): Promise<void> {
    console.log('CacheHandler.revalidateTag', { tags })
  }

  resetRequestCache(): void {
    console.log('CacheHandler.resetRequestCache')
  }

  async get(key: string): Promise<CacheHandlerValue | null> {
    console.log('CacheHandler.get', { key })
    return null
  }
}
