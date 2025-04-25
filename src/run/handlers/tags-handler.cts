import { purgeCache } from '@netlify/functions'

import { name as nextRuntimePkgName, version as nextRuntimePkgVersion } from '../../../package.json'
import { TagManifest } from '../../shared/blob-types.cjs'
import {
  getMemoizedKeyValueStoreBackedByRegionalBlobStore,
  MemoizedKeyValueStoreBackedByRegionalBlobStore,
} from '../storage/storage.cjs'

import { getLogger, getRequestContext } from './request-context.cjs'

const purgeCacheUserAgent = `${nextRuntimePkgName}@${nextRuntimePkgVersion}`

/**
 * Get timestamp of the last revalidation for a tag
 */
async function getTagRevalidatedAt(
  tag: string,
  cacheStore: MemoizedKeyValueStoreBackedByRegionalBlobStore,
): Promise<number | null> {
  const tagManifest = await cacheStore.get<TagManifest>(tag, 'tagManifest.get')
  if (!tagManifest) {
    return null
  }
  return tagManifest.revalidatedAt
}

/**
 * Check if any of the tags were invalidated since the given timestamp
 */
export function isAnyTagStale(tags: string[], timestamp: number): Promise<boolean> {
  if (tags.length === 0 || !timestamp) {
    return Promise.resolve(false)
  }

  const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })

  //    Full-route cache and fetch caches share a lot of tags
  //    but we will only do actual blob read once withing a single request due to cacheStore
  //    memoization.
  //    Additionally, we will resolve the promise as soon as we find first
  //    stale tag, so that we don't wait for all of them to resolve (but keep all
  //    running in case future `CacheHandler.get` calls would be able to use results).
  //    "Worst case" scenario is none of tag was invalidated in which case we need to wait
  //    for all blob store checks to finish before we can be certain that no tag is stale.
  return new Promise<boolean>((resolve, reject) => {
    const tagManifestPromises: Promise<boolean>[] = []

    for (const tag of tags) {
      const lastRevalidationTimestampPromise = getTagRevalidatedAt(tag, cacheStore)

      tagManifestPromises.push(
        lastRevalidationTimestampPromise.then((lastRevalidationTimestamp) => {
          if (!lastRevalidationTimestamp) {
            // tag was never revalidated
            return false
          }
          const isStale = lastRevalidationTimestamp >= timestamp
          if (isStale) {
            // resolve outer promise immediately if any of the tags is stale
            resolve(true)
            return true
          }
          return false
        }),
      )
    }

    // make sure we resolve promise after all blobs are checked (if we didn't resolve as stale yet)
    Promise.all(tagManifestPromises)
      .then((tagManifestAreStale) => {
        resolve(tagManifestAreStale.some((tagIsStale) => tagIsStale))
      })
      .catch(reject)
  })
}

/**
 * Transform a tag or tags into an array of tags and handle white space splitting and encoding
 */
function getCacheTagsFromTagOrTags(tagOrTags: string | string[]): string[] {
  return (Array.isArray(tagOrTags) ? tagOrTags : [tagOrTags])
    .flatMap((tag) => tag.split(/,|%2c/gi))
    .filter(Boolean)
}

export function purgeEdgeCache(tagOrTags: string | string[]): void {
  const tags = getCacheTagsFromTagOrTags(tagOrTags)

  if (tags.length === 0) {
    return
  }

  getLogger().debug(`[NextRuntime] Purging CDN cache for: [${tags}.join(', ')]`)

  const purgeCachePromise = purgeCache({ tags, userAgent: purgeCacheUserAgent }).catch((error) => {
    // TODO: add reporting here
    getLogger()
      .withError(error)
      .error(`[NextRuntime] Purging the cache for tags [${tags.join(',')}] failed`)
  })

  getRequestContext()?.trackBackgroundWork(purgeCachePromise)
}

async function doRevalidateTagAndPurgeEdgeCache(tags: string[]): Promise<void> {
  getLogger().withFields({ tags }).debug('doRevalidateTagAndPurgeEdgeCache')

  if (tags.length === 0) {
    return
  }

  const tagManifest: TagManifest = {
    revalidatedAt: Date.now(),
  }

  const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })

  await Promise.all(
    tags.map(async (tag) => {
      try {
        await cacheStore.set(tag, tagManifest, 'tagManifest.set')
      } catch (error) {
        getLogger().withError(error).log(`[NextRuntime] Failed to update tag manifest for ${tag}`)
      }
    }),
  )

  await purgeCache({ tags, userAgent: purgeCacheUserAgent }).catch((error) => {
    // TODO: add reporting here
    getLogger()
      .withError(error)
      .error(`[NextRuntime]: Purging the cache for tags ${tags.join(', ')} failed`)
  })
}

export function markTagsAsStaleAndPurgeEdgeCache(tagOrTags: string | string[]) {
  const tags = getCacheTagsFromTagOrTags(tagOrTags)

  const revalidateTagPromise = doRevalidateTagAndPurgeEdgeCache(tags)

  const requestContext = getRequestContext()
  if (requestContext) {
    requestContext.trackBackgroundWork(revalidateTagPromise)
  }

  return revalidateTagPromise
}
