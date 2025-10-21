import * as NextCacheTyped from 'next/cache'

const NextCache = NextCacheTyped as any

export const cacheLife: any =
  'cacheLife' in NextCache
    ? NextCache.cacheLife
    : 'unstable_cacheLife' in NextCache
      ? NextCache.unstable_cacheLife
      : () => {
          throw new Error('both unstable_cacheLife and cacheLife are missing from next/cache')
        }
export const cacheTag: any =
  'cacheTag' in NextCache
    ? NextCache.cacheTag
    : 'unstable_cacheTag' in NextCache
      ? NextCache.unstable_cacheTag
      : () => {
          throw new Error('both unstable_cacheTag and cacheTag are missing from next/cache')
        }
