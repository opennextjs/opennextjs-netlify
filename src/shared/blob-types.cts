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

// tags that have a manifest in this deploy, kept in one blob so a request reads it once
export type TagManifestIndex = {
  tags: Record<string, 1>
}

export type HtmlBlob = {
  html: string
  isFullyStaticPage: boolean
}

export type BlobType = NetlifyCacheHandlerValue | TagManifest | TagManifestIndex | HtmlBlob

export const isTagManifest = (value: BlobType): value is TagManifest => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'staleAt' in value &&
    typeof value.staleAt === 'number' &&
    'expireAt' in value &&
    typeof value.expireAt === 'number' &&
    Object.keys(value).length === 2
  )
}

export const isTagManifestIndex = (value: BlobType): value is TagManifestIndex => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tags' in value &&
    typeof value.tags === 'object' &&
    value.tags !== null &&
    Object.keys(value).length === 1
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
