// const fetchBeforeNextPatchedIt = globalThis.fetch

import { getTracer } from './tracer.cjs'

const CACHE_NAME = 'next-runtime'

const fetchBeforeNextPatchedIt = globalThis.fetch

function getURL(key: string) {
  return new URL(key, 'https://n.org')
}

export async function getFromProgrammableCache(key: string) {
  return await getTracer().withActiveSpan('pc.get', async (span) => {
    const url = getURL(key)
    span.setAttributes({ key, url: url.href })

    const cache = await caches.open(CACHE_NAME)
    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchBeforeNextPatchedIt
    const response = await cache.match(url)

    console.log({ response })
    globalThis.fetch = previousFetch
    return response?.json()
  })
}

export async function setInProgrammableCache(key: string, value: any, tags?: string[]) {
  return await getTracer().withActiveSpan('pc.set', async (span) => {
    const url = getURL(key)
    span.setAttributes({ key, url: url.href })

    const cache = await caches.open(CACHE_NAME)

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=3600',
    }

    // ignore for now
    // if (tags && tags.length !== 0) {
    //   headers['Cache-Tag'] = tags.join(',')
    // }
    const previousFetch = globalThis.fetch
    globalThis.fetch = fetchBeforeNextPatchedIt
    await cache.put(
      url,
      new Response(JSON.stringify(value), {
        headers,
      }),
    )
    globalThis.fetch = previousFetch
  })
}
