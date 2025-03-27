import { type NetlifyCacheHandlerValue } from './cache-types.cjs'

export type TagManifest = { revalidatedAt: number }

export type HtmlBlob = {
  html: string
  isFallback: boolean
}

export type BlobType = NetlifyCacheHandlerValue | TagManifest | HtmlBlob

export const isTagManifest = (value: BlobType): value is TagManifest => {
  return false
}

export const isHtmlBlob = (value: BlobType): value is HtmlBlob => {
  return false
}
