import { type NetlifyCacheHandlerValue } from './cache-types.cjs'

export type TagManifest = {
  /**
   * Timestamp when tag was revalidated. Used to determine if a tag is stale.
   */
  staleAt: number
  /**
   * Timestamp when tagged cache entry should no longer serve stale content.
   */
  expiredAt: number
}

export type HtmlBlob = {
  html: string
  isFullyStaticPage: boolean
}

export type BlobType = NetlifyCacheHandlerValue | TagManifest | HtmlBlob

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
