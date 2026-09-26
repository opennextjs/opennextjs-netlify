import { type NetlifyCacheHandlerValue } from './cache-types.cjs'

export type TagManifest = {
  /**
   * Timestamp when tag was revalidated. Used to determine if a tag is stale.
   */
  staleAt: number
  /**
   * Timestamp when tagged cache entry should no longer serve stale content.
   */
  expireAt: number
}

export type HtmlBlob = {
  html: string
  isFullyStaticPage: boolean
}

/**
 * A `'use cache: remote'` entry: the `CacheEntry` Next hands the cache handler, with its value
 * stream collected
 */
export type UseCacheBlob = {
  value: string // base64
  tags: string[]
  stale: number
  timestamp: number
  expire: number
  revalidate: number
}

/**
 * All variants of one prerender group (adapter output `groupId`: HTML, `.rsc`, segments,
 * `_next/data`), keyed by output pathname, regenerated and stored together.
 */
export type PrerenderGroupBlob = {
  lastModified: number
  revalidate: number | false
  expire: number | undefined
  tags: string[]
  variants: Record<string, { status: number; headers: Record<string, string>; body: string }>
}

export const getPrerenderGroupBlobKey = (entryPathname: string) =>
  `prerender-group:${entryPathname}`

// Pages Router responses carry no `x-next-cache-tags`: tag them by path, as `revalidatePath` does
export const getPrerenderGroupTags = (entryPathname: string, cacheTagsHeader?: string) =>
  cacheTagsHeader?.split(',') ?? [`_N_T_${entryPathname}`]

export type BlobType =
  | NetlifyCacheHandlerValue
  | TagManifest
  | HtmlBlob
  | UseCacheBlob
  | PrerenderGroupBlob

export const isTagManifest = (value: BlobType): value is TagManifest => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'staleAt' in value &&
    typeof value.staleAt === 'number' &&
    'expiredAt' in value &&
    typeof value.expiredAt === 'number' &&
    Object.keys(value).length === 2
  )
}

export const isHtmlBlob = (value: BlobType): value is HtmlBlob => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'html' in value &&
    'isFullyStaticPage' in value &&
    typeof value.html === 'string' &&
    typeof value.isFullyStaticPage === 'boolean' &&
    Object.keys(value).length === 2
  )
}

export const isUseCacheBlob = (value: BlobType): value is UseCacheBlob => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    typeof value.value === 'string' &&
    'timestamp' in value &&
    typeof value.timestamp === 'number'
  )
}
