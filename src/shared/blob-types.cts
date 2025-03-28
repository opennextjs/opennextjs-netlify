import { type NetlifyCacheHandlerValue } from './cache-types.cjs'

export type TagManifest = { revalidatedAt: number }

export type HtmlBlob = {
  html: string
  isFallback: boolean
}

export type BlobType = NetlifyCacheHandlerValue | TagManifest | HtmlBlob

export const isTagManifest = (value: BlobType): value is TagManifest => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'revalidatedAt' in value &&
    typeof value.revalidatedAt === 'number' &&
    Object.keys(value).length === 1
  )
}

export const isHtmlBlob = (value: BlobType): value is HtmlBlob => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'html' in value &&
    'isFallback' in value &&
    typeof value.html === 'string' &&
    typeof value.isFallback === 'boolean' &&
    Object.keys(value).length === 2
  )
}
