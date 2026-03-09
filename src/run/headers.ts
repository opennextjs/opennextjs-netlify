import type { Span } from '@netlify/otel/opentelemetry'
import type { NextConfigComplete } from 'next/dist/server/config-shared.js'

import type { NetlifyCachedRouteValue, NetlifyCacheHandlerValue } from '../shared/cache-types.cjs'

import { RequestContext } from './handlers/request-context.cjs'
import { recordWarning } from './handlers/tracer.cjs'
import { getMemoizedKeyValueStoreBackedByRegionalBlobStore } from './storage/storage.cjs'

const ALL_VARIATIONS = Symbol.for('ALL_VARIATIONS')
interface NetlifyVaryValues {
  header: string[]
  language: string[]
  cookie: string[]
  /**
   * Query variation can be without argument in which case all query combinations would create a new cache key
   * This is represented by a ALL_VARIATIONS in the array.
   */
  query: (string | typeof ALL_VARIATIONS)[]
  country: string[]
}

const NetlifyVaryKeys = new Set(['header', 'language', 'cookie', 'query', 'country'])
const isNetlifyVaryKey = (key: string): key is keyof NetlifyVaryValues => NetlifyVaryKeys.has(key)

const generateNetlifyVaryValues = ({
  header,
  language,
  cookie,
  query,
  country,
}: NetlifyVaryValues): string => {
  const values: string[] = []
  if (query.length !== 0) {
    if (query.includes(ALL_VARIATIONS)) {
      values.push(`query`)
    } else {
      values.push(`query=${query.join(`|`)}`)
    }
  }
  if (header.length !== 0) {
    const uniqueHeaderNames = [
      ...new Set(
        header.map((headerName) =>
          // header names are case insensitive
          headerName.toLowerCase(),
        ),
      ),
    ]
    values.push(`header=${uniqueHeaderNames.join(`|`)}`)
  }
  if (language.length !== 0) {
    values.push(`language=${language.join(`|`)}`)
  }
  if (cookie.length !== 0) {
    values.push(`cookie=${cookie.join(`|`)}`)
  }
  if (country.length !== 0) {
    values.push(`country=${country.join(`|`)}`)
  }
  return values.join(',')
}

const getHeaderValueArray = (header: string): string[] => {
  return header
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

const omitHeaderValues = (header: string, values: string[]): string => {
  const headerValues = getHeaderValueArray(header)
  const filteredValues = headerValues.filter(
    (value) => !values.some((val) => value.startsWith(val)),
  )
  return filteredValues.join(', ')
}

/**
 * Ensure the Netlify CDN varies on things that Next.js varies on,
 * e.g. i18n, preview mode, etc.
 */
export const setVaryHeaders = (
  headers: Headers,
  request: Request,
  { basePath, i18n }: Pick<NextConfigComplete, 'basePath' | 'i18n'>,
) => {
  const netlifyVaryValues: NetlifyVaryValues = {
    header: [
      'x-nextjs-data',
      'x-next-debug-logging',
      // using _rsc query param might not be enough because it is stripped for middleware redirect and rewrites
      // so adding all request headers that are used to produce the _rsc query param
      // https://github.com/vercel/next.js/blob/e5fe535ed17cee5e1d5576ccc33e4c49b5da1273/packages/next/src/client/components/router-reducer/set-cache-busting-search-param.ts#L32-L39
      'Next-Router-Prefetch',
      'Next-Router-Segment-Prefetch',
      'Next-Router-State-Tree',
      'Next-Url',
      // and exact header that actually instruct Next.js to produce RSC response
      'RSC',
    ],
    language: [],
    cookie: ['__prerender_bypass', '__next_preview_data'],
    query: ['__nextDataReq', '_rsc'],
    country: [],
  }

  const vary = headers.get('vary')
  if (vary !== null) {
    netlifyVaryValues.header.push(...getHeaderValueArray(vary))
  }

  const path = new URL(request.url).pathname
  const locales = i18n && i18n.localeDetection !== false ? i18n.locales : []

  if (locales.length > 1 && (path === '/' || path === basePath)) {
    netlifyVaryValues.language.push(...locales)
    netlifyVaryValues.cookie.push(`NEXT_LOCALE`)
  }

  const userNetlifyVary = headers.get('netlify-vary')
  if (userNetlifyVary) {
    // respect user's header and append them
    const directives = getHeaderValueArray(userNetlifyVary)
    for (const directive of directives) {
      const [key, value] = directive.split('=')

      if (key === 'query' && !value) {
        // query can have no "assignment" and then it should vary on all possible query combinations
        netlifyVaryValues.query.push(ALL_VARIATIONS)
      } else if (value && isNetlifyVaryKey(key)) {
        netlifyVaryValues[key].push(...value.split('|'))
      }
    }
  }

  headers.set(`netlify-vary`, generateNetlifyVaryValues(netlifyVaryValues))
}

/**
 * Change the date header to be the last-modified date of the blob. This means the CDN
 * will use the correct expiry time for the response. e.g. if the blob was last modified
 * 5 seconds ago and is sent with a maxage of 10, the CDN will cache it for 5 seconds.
 * By default, Next.js sets the date header to the current time, even if it's served
 * from the cache, meaning that the CDN will cache it for 10 seconds, which is incorrect.
 */
export const adjustDateHeader = async ({
  headers,
  request,
  span,
  requestContext,
}: {
  headers: Headers
  request: Request
  span?: Span
  requestContext: RequestContext
}) => {
  const key = new URL(request.url).pathname

  let lastModified: number | undefined
  if (requestContext.responseCacheGetLastModified) {
    lastModified = requestContext.responseCacheGetLastModified
  } else {
    // this is fallback in case requestContext doesn't contain lastModified
    // using fallback indicate problem in the setup as assumption is that for cached responses
    // request context would contain lastModified value
    // this is not fatal as we have fallback,
    // but we want to know about it happening
    recordWarning(
      new Error('lastModified not found in requestContext, falling back to trying blobs'),
      span,
    )

    const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })
    const cacheEntry = await cacheStore.get<NetlifyCacheHandlerValue>(
      key,
      'get cache to calculate date header',
    )
    lastModified = cacheEntry?.lastModified
  }

  if (!lastModified) {
    // this should never happen as we only execute this code path for cached responses
    // and those should always have lastModified value
    recordWarning(
      new Error(
        'lastModified not found in either requestContext or blobs, date header for cached response is not set',
      ),
      span,
    )

    return
  }

  const lastModifiedDate = new Date(lastModified)
  // Show actual date of the function call in the date header
  headers.set('x-nextjs-date', headers.get('date') ?? lastModifiedDate.toUTCString())
  // Setting Age also would work, but we already have the lastModified time so will use that.
  headers.set('date', lastModifiedDate.toUTCString())
}

function setCacheControlFromRequestContext(
  headers: Headers,
  revalidate: NetlifyCachedRouteValue['revalidate'],
) {
  const cdnCacheControl =
    // if we are serving already stale response, instruct edge to not attempt to cache that response
    headers.get('x-nextjs-cache') === 'STALE'
      ? 'public, max-age=0, must-revalidate, durable'
      : `s-maxage=${revalidate || 31536000}, stale-while-revalidate=31536000, durable`

  headers.set('netlify-cdn-cache-control', cdnCacheControl)
}

export function notFoundHeuristics(
  request: Request,
  headers: Headers,
  requestContext: RequestContext,
) {
  if (request.url.endsWith('.php')) {
    // temporary CDN Cache Control handling for bot probes on PHP files
    // https://linear.app/netlify/issue/FRB-1344/prevent-excessive-ssr-invocations-due-to-404-routes
    headers.set('cache-control', 'public, max-age=0, must-revalidate')
    headers.set('netlify-cdn-cache-control', `max-age=31536000, durable`)
    return true
  }

  if (
    process.env.CACHE_404_PAGE &&
    request.url.endsWith('/404') &&
    ['GET', 'HEAD'].includes(request.method)
  ) {
    // handle CDN Cache Control on 404 Page responses
    setCacheControlFromRequestContext(headers, requestContext.pageHandlerRevalidate)
    return true
  }

  return false
}

/**
 * Ensure stale-while-revalidate and s-maxage don't leak to the client, but
 * assume the user knows what they are doing if CDN cache controls are set
 */
export const setCacheControlHeaders = (
  { headers, status }: Response,
  request: Request,
  requestContext: RequestContext,
) => {
  if (
    typeof requestContext.routeHandlerRevalidate !== 'undefined' &&
    ['GET', 'HEAD'].includes(request.method) &&
    (headers.has('x-nextjs-cache') ||
      (!headers.has('cdn-cache-control') && !headers.has('netlify-cdn-cache-control')))
  ) {
    // handle CDN Cache Control on Route Handler responses
    setCacheControlFromRequestContext(headers, requestContext.routeHandlerRevalidate)
    return
  }

  if (status === 404 && notFoundHeuristics(request, headers, requestContext)) {
    return
  }

  const cacheControl = headers.get('cache-control')

  if (
    cacheControl !== null &&
    ['GET', 'HEAD'].includes(request.method) &&
    (headers.has('x-nextjs-cache') ||
      (!headers.has('cdn-cache-control') && !headers.has('netlify-cdn-cache-control')))
  ) {
    // handle CDN Cache Control on ISR and App Router page responses
    const browserCacheControl = omitHeaderValues(cacheControl, [
      's-maxage',
      'stale-while-revalidate',
    ])

    // before https://github.com/vercel/next.js/pull/86554 Next.js was using only cache-control,
    // after that it will prefer cdn-cache-control, in particular for stale-while-revalidate directive
    // so we need to handle both headers here
    const cacheControlForCdnFromNext = headers.get('cdn-cache-control') ?? cacheControl

    const cdnCacheControl =
      // if we are serving already stale response, instruct edge to not attempt to cache that response
      headers.get('x-nextjs-cache') === 'STALE'
        ? 'public, max-age=0, must-revalidate, durable'
        : [
            ...getHeaderValueArray(cacheControlForCdnFromNext).map((value) =>
              value === 'stale-while-revalidate' ? 'stale-while-revalidate=31536000' : value,
            ),
            'durable',
          ].join(', ')

    headers.set('cache-control', browserCacheControl || 'public, max-age=0, must-revalidate')
    // if cdn-cache-control is set by Next.js we need to remove it to avoid confusion, as we will be using netlify-cdn-cache-control
    headers.delete('cdn-cache-control')
    headers.set('netlify-cdn-cache-control', cdnCacheControl)
    return
  }

  if (
    cacheControl === null &&
    ['GET', 'HEAD'].includes(request.method) &&
    !headers.has('cdn-cache-control') &&
    !headers.has('netlify-cdn-cache-control') &&
    requestContext.usedFsReadForNonFallback &&
    !requestContext.didPagesRouterOnDemandRevalidate
  ) {
    // handle CDN Cache Control on static files
    headers.set('cache-control', 'public, max-age=0, must-revalidate')
    headers.set('netlify-cdn-cache-control', `max-age=31536000, durable`)
  }
}

export const setCacheTagsHeaders = (headers: Headers, requestContext: RequestContext) => {
  if (!headers.has('cache-control') && !headers.has('netlify-cdn-cache-control')) {
    return
  }

  if (requestContext.responseCacheTags) {
    headers.set('netlify-cache-tag', requestContext.responseCacheTags.join(','))
  }
}

/**
 * https://httpwg.org/specs/rfc9211.html
 *
 * We get HIT, MISS, STALE statuses from Next cache.
 * We will ignore other statuses and will not set Cache-Status header in those cases.
 */
const NEXT_CACHE_TO_CACHE_STATUS: Record<string, string> = {
  HIT: `hit`,
  MISS: `fwd=miss`,
  STALE: `hit; fwd=stale`,
}

/**
 * x-nextjs-cache header will be confusing to users as very often it will be MISS
 * even when the CDN serves cached the response. So we'll remove it and instead add
 * a Cache-Status header for Next cache so users inspect that together with CDN cache status
 * and not on its own.
 */
export const setCacheStatusHeader = (headers: Headers, nextCache: string | null) => {
  if (typeof nextCache === 'string') {
    if (nextCache in NEXT_CACHE_TO_CACHE_STATUS) {
      const cacheStatus = NEXT_CACHE_TO_CACHE_STATUS[nextCache]
      headers.set('cache-status', `"Next.js"; ${cacheStatus}`)
    }

    headers.delete('x-nextjs-cache')
  }
}
