import { purgeCache } from '@netlify/functions'

import { name as nextRuntimePkgName, version as nextRuntimePkgVersion } from '../../../package.json'
import { TagManifest, TagRevalidationMarker } from '../../shared/blob-types.cjs'
import {
  getMemoizedKeyValueStoreBackedByRegionalBlobStore,
  MemoizedKeyValueStoreBackedByRegionalBlobStore,
} from '../storage/storage.cjs'

import { getLogger, getRequestContext } from './request-context.cjs'

const purgeCacheUserAgent = `${nextRuntimePkgName}@${nextRuntimePkgVersion}`

// written on the first revalidation in a deploy; while it is absent no tag can have a manifest
export const TAG_REVALIDATION_MARKER_KEY = 'netlify:tags-revalidated'

const MARKER_SEEN = Symbol.for('nf-tag-revalidation-marker-seen')
const extendedGlobalThis = globalThis as typeof globalThis & { [MARKER_SEEN]?: boolean }

// the marker never goes away within a deploy, so once a process has seen it there is nothing left to read
async function hasAnyTagBeenRevalidated(
  cacheStore: MemoizedKeyValueStoreBackedByRegionalBlobStore,
): Promise<boolean> {
  if (extendedGlobalThis[MARKER_SEEN]) {
    return true
  }
  const marker = await cacheStore.get<TagRevalidationMarker>(
    TAG_REVALIDATION_MARKER_KEY,
    'tagRevalidationMarker.get',
  )
  if (marker) {
    extendedGlobalThis[MARKER_SEEN] = true
  }
  return Boolean(marker)
}

// start the marker read early so it overlaps the entry read; memoized per request
export function prefetchTagRevalidationMarker(): void {
  if (extendedGlobalThis[MARKER_SEEN]) {
    return
  }
  const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })
  cacheStore
    .get<TagRevalidationMarker>(TAG_REVALIDATION_MARKER_KEY, 'tagRevalidationMarker.get')
    .catch(() => {
      // the real read reports failures
    })
}

async function writeTagRevalidationMarker(
  cacheStore: MemoizedKeyValueStoreBackedByRegionalBlobStore,
): Promise<void> {
  if (extendedGlobalThis[MARKER_SEEN]) {
    return
  }
  try {
    await cacheStore.set(
      TAG_REVALIDATION_MARKER_KEY,
      { revalidatedAt: Date.now() },
      'tagRevalidationMarker.set',
    )
    extendedGlobalThis[MARKER_SEEN] = true
  } catch (error) {
    getLogger().withError(error).log('[NextRuntime] Failed to write tag revalidation marker')
  }
}

async function getTagManifest(
  tag: string,
  cacheStore: MemoizedKeyValueStoreBackedByRegionalBlobStore,
): Promise<TagManifest | null> {
  const tagManifest = await cacheStore.get<TagManifest>(tag, 'tagManifest.get')
  if (!tagManifest) {
    return null
  }
  return tagManifest
}

/**
 * Get the most recent revalidation timestamp for a list of tags
 */
export async function getMostRecentTagExpirationTimestamp(tags: string[]) {
  if (tags.length === 0) {
    return 0
  }

  const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })

  if (!(await hasAnyTagBeenRevalidated(cacheStore))) {
    return 0
  }

  const manifestsOrNulls = await Promise.all(tags.map((tag) => getTagManifest(tag, cacheStore)))

  const expirationTimestamps = manifestsOrNulls
    .filter((manifest) => manifest !== null)
    .map((manifest) => manifest.expireAt)
  if (expirationTimestamps.length === 0) {
    return 0
  }
  return Math.max(...expirationTimestamps)
}

export type TagStaleOrExpiredStatus =
  // FRESH
  | { stale: false; expired: false }
  // STALE
  | { stale: true; expired: false; expireAt: number }
  // EXPIRED (should be treated similarly to MISS)
  | { stale: true; expired: true }

/**
 * Check if any of the tags expired since the given timestamp
 */
export async function isAnyTagStaleOrExpired(
  tags: string[],
  timestamp: number,
): Promise<TagStaleOrExpiredStatus> {
  if (tags.length === 0 || !timestamp) {
    return { stale: false, expired: false }
  }

  const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })

  if (!(await hasAnyTagBeenRevalidated(cacheStore))) {
    return { stale: false, expired: false }
  }

  //    Full-route cache and fetch caches share a lot of tags
  //    but we will only do actual blob read once withing a single request due to cacheStore
  //    memoization.
  //    Additionally, we will resolve the promise as soon as we find first
  //    expired tag, so that we don't wait for all of them to resolve (but keep all
  //    running in case future `CacheHandler.get` calls would be able to use results).
  //    "Worst case" scenario is none of tag was expired in which case we need to wait
  //    for all blob store checks to finish before we can be certain that no tag is expired.
  return new Promise<TagStaleOrExpiredStatus>((resolve, reject) => {
    const tagManifestPromises: Promise<TagStaleOrExpiredStatus>[] = []

    for (const tag of tags) {
      const tagManifestPromise = getTagManifest(tag, cacheStore)

      tagManifestPromises.push(
        tagManifestPromise.then((tagManifest) => {
          if (!tagManifest) {
            // tag was never revalidated
            return { stale: false, expired: false }
          }
          const stale = tagManifest.staleAt >= timestamp
          const expired = tagManifest.expireAt >= timestamp && tagManifest.expireAt <= Date.now()

          if (expired && stale) {
            const expiredResult: TagStaleOrExpiredStatus = {
              stale,
              expired,
            }
            // resolve outer promise immediately if any of the tags is expired
            resolve(expiredResult)
            return expiredResult
          }

          if (stale) {
            const staleResult: TagStaleOrExpiredStatus = {
              stale,
              expired,
              expireAt: tagManifest.expireAt,
            }
            return staleResult
          }
          return { stale: false, expired: false }
        }),
      )
    }

    // make sure we resolve promise after all blobs are checked (if we didn't resolve as expired yet)
    Promise.all(tagManifestPromises)
      .then((tagManifestsAreStaleOrExpired) => {
        let result: TagStaleOrExpiredStatus = { stale: false, expired: false }

        for (const tagResult of tagManifestsAreStaleOrExpired) {
          if (tagResult.expired) {
            // if any of the tags is expired, the whole thing is expired
            result = tagResult
            break
          }

          if (tagResult.stale) {
            result = {
              stale: true,
              expired: false,
              expireAt:
                // make sure to use expireAt that is lowest of all tags
                result.stale && !result.expired && typeof result.expireAt === 'number'
                  ? Math.min(result.expireAt, tagResult.expireAt)
                  : tagResult.expireAt,
            }
          }
        }

        resolve(result)
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

/**
 * Same rule as Next's `encodeHeaderSafe` (`server/lib/encode-header-safe.ts`): percent-encode only
 * what an HTTP header cannot carry, and leave everything printable-ASCII alone. Crucially it is
 * idempotent on `%xx`, which `encodeURI` is not - a key that already contains `%2F` (a dynamic
 * param holding a path, say) came out as `%252F`, so the tag we attached never matched the one
 * `revalidatePath`/`revalidateTag` purges, and the CDN entry was never invalidated.
 */
const OUT_OF_CLASS_CHAR = /[^\t\u0020-\u007E]/
const OUT_OF_CLASS_RUN = /[^\t\u0020-\u007E]+/g
export const encodeCacheTag = (value: string): string =>
  OUT_OF_CLASS_CHAR.test(value)
    ? value.replace(OUT_OF_CLASS_RUN, (run) => encodeURIComponent(run))
    : value

export function purgeEdgeCache(tagOrTags: string | string[]): Promise<void> {
  const tags = getCacheTagsFromTagOrTags(tagOrTags)

  if (tags.length === 0) {
    return Promise.resolve()
  }

  getLogger().debug(`[NextRuntime] Purging CDN cache for: [${tags}.join(', ')]`)

  return purgeCache({ tags, userAgent: purgeCacheUserAgent }).catch((error) => {
    // TODO: add reporting here
    getLogger()
      .withError(error)
      .error(`[NextRuntime] Purging the cache for tags [${tags.join(',')}] failed`)
  })
}

// shape of this type comes from Next.js https://github.com/vercel/next.js/blob/fffa2831b61fa74852736eeaad2f17fbdd553bce/packages/next/src/server/lib/incremental-cache/index.ts#L78
// and we use it internally
export type RevalidateTagDurations = {
  /**
   * Number of seconds after which tagged cache entries should no longer serve stale content.
   */
  expire?: number
}

async function doRevalidateTagAndPurgeEdgeCache(
  tags: string[],
  durations?: RevalidateTagDurations,
): Promise<void> {
  getLogger().withFields({ tags, durations }).debug('doRevalidateTagAndPurgeEdgeCache')

  if (tags.length === 0) {
    return
  }

  const now = Date.now()

  const tagManifest: TagManifest = {
    staleAt: now,
    expireAt: now + (durations?.expire ? durations.expire * 1000 : 0),
  }

  const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })

  // a reader that sees only one of the marker and the manifest still sees the pre-revalidation state, so these can race
  await Promise.all([
    writeTagRevalidationMarker(cacheStore),
    ...tags.map(async (tag) => {
      try {
        await cacheStore.set(tag, tagManifest, 'tagManifest.set')
      } catch (error) {
        getLogger().withError(error).log(`[NextRuntime] Failed to update tag manifest for ${tag}`)
      }
    }),
  ])

  await purgeEdgeCache(tags)
}

export function markTagsAsStaleAndPurgeEdgeCache(
  tagOrTags: string | string[],
  durations?: RevalidateTagDurations,
) {
  const tags = getCacheTagsFromTagOrTags(tagOrTags)

  // Next.js is calling classic CacheHandler.revalidateTag and 'use cache' CacheHandler expireTags/updateTags separately
  // this results in duplicate work being done (it doesn't cause problems, but it is inefficient)
  // See https://github.com/vercel/next.js/blob/8cab15c0c947a71eb8606ba29da719a2e121fc88/packages/next/src/server/revalidation-utils.ts#L170-L180
  // Deduping those within context of a single request might catch unrelated invalidations, so instead of using just request context
  // we will check if they happened in same event loop tick as well.
  const revalidationKey = JSON.stringify({ tags, durations })
  const requestContext = getRequestContext()

  if (requestContext) {
    const ongoingRevalidation = requestContext.ongoingRevalidations?.get(revalidationKey)
    if (ongoingRevalidation) {
      // If we already have an ongoing revalidation for this key, we can use it
      return ongoingRevalidation
    }
  }

  const revalidateTagPromise = doRevalidateTagAndPurgeEdgeCache(tags, durations)

  if (requestContext) {
    requestContext.ongoingRevalidations ??= new Map()
    requestContext.ongoingRevalidations.set(revalidationKey, revalidateTagPromise)
    process.nextTick(() => {
      requestContext.ongoingRevalidations?.delete(revalidationKey)
    })
    requestContext.trackBackgroundWork(revalidateTagPromise)
  }

  return revalidateTagPromise
}
