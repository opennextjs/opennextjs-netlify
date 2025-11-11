import { getDeployStore } from '@netlify/blobs'

import type { ISRCacheEntry } from '../build/netlify-adapter-context.js'
import type { NetlifyAdapterContext } from '../build/types.js'

function cacheEntryToResponse(entry: ISRCacheEntry, source: 'fallback' | 'blobs') {
  const headers = new Headers(entry.headers ?? {})

  headers.set('x-isr-revalidate', String(entry.revalidate ?? 'undefined'))
  headers.set('x-isr-expiration', String(entry.expiration ?? 'undefined'))
  headers.set('x-isr-source', source)

  return new Response(entry.content, {
    status: entry.status ?? 200,
    headers,
  })
}

export async function getIsrResponse(
  request: Request,
  outputs: NetlifyAdapterContext['preparedOutputs'],
) {
  const def = matchIsrDefinitionFromOutputs(request, outputs)
  if (!def) {
    return
  }

  const cacheKey = generateIsrCacheKey(request, def)
  const store = getDeployStore({ consistency: 'strong', region: 'us-east-2' })

  const cachedEntry = await store.get(cacheKey, { type: 'json' })
  if (cachedEntry) {
    return cacheEntryToResponse(cachedEntry as ISRCacheEntry, 'blobs')
  }

  if (!def.fallback) {
    return
  }

  return cacheEntryToResponse(def.fallback, 'fallback')
}

export function matchIsrGroupFromOutputs(
  request: Request,
  outputs: Pick<NetlifyAdapterContext['preparedOutputs'], 'endpoints' | 'isrGroups'>,
) {
  const { pathname } = new URL(request.url)

  const endpoint = outputs.endpoints[pathname.toLowerCase()]
  if (!endpoint || endpoint.type !== 'isr') {
    return
  }

  return outputs.isrGroups[endpoint.isrGroup]
}

export function matchIsrDefinitionFromIsrGroup(
  request: Request,
  isrGroup: NetlifyAdapterContext['preparedOutputs']['isrGroups'][number],
) {
  const { pathname } = new URL(request.url)

  return isrGroup.find((def) => def.pathname === pathname)
}

export function matchIsrDefinitionFromOutputs(
  request: Request,
  outputs: Pick<NetlifyAdapterContext['preparedOutputs'], 'endpoints' | 'isrGroups'>,
) {
  const defs = matchIsrGroupFromOutputs(request, outputs)

  if (!defs) {
    return
  }

  return matchIsrDefinitionFromIsrGroup(request, defs)
}

export function requestToIsrRequest(
  request: Request,
  def: NetlifyAdapterContext['preparedOutputs']['isrGroups'][number][number],
) {
  const isrUrl = new URL(request.url)

  // eslint-disable-next-line unicorn/no-useless-spread
  for (const queryKey of [...isrUrl.searchParams.keys()]) {
    if (!def.queryParams.includes(queryKey)) {
      isrUrl.searchParams.delete(queryKey)
    }
  }

  // we should strip headers as well - at very least conditional ones, but probably better to just use allowed headers like so
  //       "allowHeader": [
  //   "host",
  //   "x-matched-path",
  //   "x-prerender-revalidate",
  //   "x-prerender-revalidate-if-generated",
  //   "x-next-revalidated-tags",
  //   "x-next-revalidate-tag-token"
  // ],

  return new Request(isrUrl, request)
}

export function generateIsrCacheKey(
  request: Request,
  def: NetlifyAdapterContext['preparedOutputs']['isrGroups'][number][number],
) {
  const parts = ['isr', def.pathname]

  const url = new URL(request.url)

  for (const queryParamName of def.queryParams) {
    const value = url.searchParams.get(queryParamName) ?? ''
    parts.push(`${queryParamName}=${value}`)
  }

  return parts.join(':')
}

export async function responseToCacheEntry(response: Response): Promise<ISRCacheEntry> {
  const content = await response.text()
  const headers: Record<string, string> = Object.fromEntries(response.headers.entries())

  return { content, headers, status: response.status }
}

export async function storeIsrGroupUpdate(update: Record<string, ISRCacheEntry>) {
  const store = getDeployStore({ consistency: 'strong', region: 'us-east-2' })

  await Promise.all(
    Object.entries(update).map(async ([key, entry]) => {
      await store.setJSON(key, entry)
    }),
  )
}
