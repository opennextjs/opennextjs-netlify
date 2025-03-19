import { isPromise } from 'node:util/types'

import type {
  CacheHandler,
  CacheHandlerValue,
} from 'next/dist/server/lib/incremental-cache/index.js'
import type {
  CachedFetchValue,
  CachedRouteValue,
  IncrementalCachedAppPageValue,
  IncrementalCachedPageValue,
  IncrementalCacheValue,
} from 'next/dist/server/response-cache/types.js'

import { recordWarning } from '../run/handlers/tracer.cjs'

export type { CacheHandlerContext } from 'next/dist/server/lib/incremental-cache/index.js'

type CacheControl = {
  revalidate: Parameters<CacheHandler['set']>[2]['revalidate']
  expire: number | undefined
}

/**
 * Shape of the cache value that is returned from CacheHandler.get or passed to CacheHandler.set
 */
type CachedRouteValueForMultipleVersions = Omit<CachedRouteValue, 'kind'> & {
  kind: 'ROUTE' | 'APP_ROUTE'
}

/**
 * Used for storing in blobs and reading from blobs
 */
export type NetlifyCachedRouteValue = Omit<CachedRouteValueForMultipleVersions, 'body'> & {
  // Next.js stores body as buffer, while we store it as base64 encoded string
  body: string
  // Next.js doesn't produce cache-control tag we use to generate cdn cache control
  // so store needed values as part of cached response data
  revalidate?: Parameters<CacheHandler['set']>[2]['revalidate']
  cacheControl?: CacheControl
}

/**
 * Shape of the cache value that is returned from CacheHandler.get or passed to CacheHandler.set
 */
type IncrementalCachedAppPageValueForMultipleVersions = Omit<
  IncrementalCachedAppPageValue,
  'kind'
> & {
  kind: 'APP_PAGE'
}

/**
 * Used for storing in blobs and reading from blobs
 */
export type NetlifyCachedAppPageValue = Omit<
  IncrementalCachedAppPageValueForMultipleVersions,
  'rscData'
> & {
  // Next.js stores rscData as buffer, while we store it as base64 encoded string
  rscData: string | undefined
  revalidate?: Parameters<CacheHandler['set']>[2]['revalidate']
  cacheControl?: CacheControl
}

/**
 * Shape of the cache value that is returned from CacheHandler.get or passed to CacheHandler.set
 */
type IncrementalCachedPageValueForMultipleVersions = Omit<IncrementalCachedPageValue, 'kind'> & {
  kind: 'PAGE' | 'PAGES'
}

/**
 * Used for storing in blobs and reading from blobs
 */
export type NetlifyCachedPageValue = IncrementalCachedPageValueForMultipleVersions & {
  revalidate?: Parameters<CacheHandler['set']>[2]['revalidate']
  cacheControl?: CacheControl
}

export type CachedFetchValueForMultipleVersions = Omit<CachedFetchValue, 'kind'> & {
  kind: 'FETCH'
}

type CachedRouteValueToNetlify<T> = T extends CachedRouteValue
  ? NetlifyCachedRouteValue
  : T extends IncrementalCachedPageValue
    ? NetlifyCachedPageValue
    : T extends IncrementalCachedAppPageValue
      ? NetlifyCachedAppPageValue
      : T

type MapCachedRouteValueToNetlify<T> = { [K in keyof T]: CachedRouteValueToNetlify<T[K]> } & {
  lastModified: number
}

/**
 * Used for storing in blobs and reading from blobs
 */
export type NetlifyCacheHandlerValue = MapCachedRouteValueToNetlify<CacheHandlerValue>

/**
 * Used for storing in blobs and reading from blobs
 */
export type NetlifyIncrementalCacheValue = NetlifyCacheHandlerValue['value']

type IncrementalCacheValueToMultipleVersions<T> = T extends CachedRouteValue
  ? CachedRouteValueForMultipleVersions
  : T extends IncrementalCachedPageValue
    ? IncrementalCachedPageValueForMultipleVersions
    : T extends IncrementalCachedAppPageValue
      ? IncrementalCachedAppPageValueForMultipleVersions
      : T extends CachedFetchValue
        ? CachedFetchValueForMultipleVersions
        : T extends CacheHandlerValue
          ? {
              [K in keyof T]: IncrementalCacheValueToMultipleVersions<T[K]>
            }
          : T

type IncrementalCacheValueForMultipleVersions =
  IncrementalCacheValueToMultipleVersions<IncrementalCacheValue>

export const isCachedPageValue = (
  value: IncrementalCacheValueForMultipleVersions,
): value is IncrementalCachedPageValueForMultipleVersions =>
  value.kind === 'PAGE' || value.kind === 'PAGES'

export const isCachedRouteValue = (
  value: IncrementalCacheValueForMultipleVersions,
): value is CachedRouteValueForMultipleVersions =>
  value.kind === 'ROUTE' || value.kind === 'APP_ROUTE'

type MapArgsOrReturn<T> = T extends readonly unknown[]
  ? { [K in keyof T]: MapArgsOrReturn<T[K]> }
  : T extends Promise<infer P>
    ? Promise<MapArgsOrReturn<P>>
    : IncrementalCacheValueToMultipleVersions<T>

type MapCacheHandlerClassMethod<T> = T extends (...args: infer Args) => infer Ret
  ? (...args: MapArgsOrReturn<Args>) => MapArgsOrReturn<Ret>
  : T

type MapCacheHandlerClass<T> = { [K in keyof T]: MapCacheHandlerClassMethod<T[K]> }

type BaseCacheHandlerForMultipleVersions = MapCacheHandlerClass<CacheHandler>

type CacheHandlerSetContext = Parameters<CacheHandler['set']>[2]

type CacheHandlerSetContextForMultipleVersions = CacheHandlerSetContext & {
  cacheControl?: CacheControl
}

export type CacheHandlerForMultipleVersions = BaseCacheHandlerForMultipleVersions & {
  set: (
    key: Parameters<BaseCacheHandlerForMultipleVersions['set']>[0],
    value: Parameters<BaseCacheHandlerForMultipleVersions['set']>[1],
    context: CacheHandlerSetContextForMultipleVersions,
  ) => ReturnType<BaseCacheHandlerForMultipleVersions['set']>
}

export type TagManifest = { revalidatedAt: number }

export type HtmlBlob = {
  html: string
  isFallback: boolean
}

export type BlobType = NetlifyCacheHandlerValue | TagManifest | HtmlBlob

const isTagManifest = (value: BlobType): value is TagManifest => {
  return false
}

const isHtmlBlob = (value: BlobType): value is HtmlBlob => {
  return false
}

export const estimateBlobSize = (valueToStore: BlobType | null | Promise<unknown>): number => {
  // very approximate size calculation to avoid expensive exact size calculation
  // inspired by https://github.com/vercel/next.js/blob/ed10f7ed0246fcc763194197eb9beebcbd063162/packages/next/src/server/lib/incremental-cache/file-system-cache.ts#L60-L79
  if (valueToStore === null || isPromise(valueToStore) || isTagManifest(valueToStore)) {
    return 25
  }
  if (isHtmlBlob(valueToStore)) {
    return valueToStore.html.length
  }
  let knownKindFailed = false
  try {
    if (valueToStore.value?.kind === 'FETCH') {
      return valueToStore.value.data.body.length
    }
    if (valueToStore.value?.kind === 'APP_PAGE') {
      return valueToStore.value.html.length + (valueToStore.value.rscData?.length ?? 0)
    }
    if (valueToStore.value?.kind === 'PAGE' || valueToStore.value?.kind === 'PAGES') {
      return valueToStore.value.html.length + JSON.stringify(valueToStore.value.pageData).length
    }
    if (valueToStore.value?.kind === 'ROUTE' || valueToStore.value?.kind === 'APP_ROUTE') {
      return valueToStore.value.body.length
    }
  } catch {
    // size calculation rely on the shape of the value, so if it's not what we expect, we fallback to JSON.stringify
    knownKindFailed = true
  }

  // fallback for not known kinds or known kinds that did fail to calculate size
  // we should also monitor cases when fallback is used because it's not the most efficient way to calculate/estimate size
  // and might indicate need to make adjustments or additions to the size calculation
  recordWarning(
    new Error(
      `Blob size calculation did fallback to JSON.stringify. Kind: KnownKindFailed: ${knownKindFailed}, ${valueToStore.value?.kind ?? 'undefined'}`,
    ),
  )

  return JSON.stringify(valueToStore).length
}
