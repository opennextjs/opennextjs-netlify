import { describe, expect, test, vi } from 'vitest'

import { finalize } from './finalize.js'
import type { StoredCache } from './types.js'

vi.mock('./manifest.js', () => ({
  manifest: { config: { basePath: '', i18n: null, trailingSlash: false } },
}))

const lastModified = Date.UTC(2026, 9, 10, 12, 0, 0)

async function finalizeStored(
  cache: Partial<StoredCache>,
  nextHeaders?: Record<string, string>,
  routed?: (response: Response) => Response,
) {
  const response = await finalize(
    {
      kind: 'stored',
      response: new Response('body', { headers: nextHeaders }),
      cache: { revalidate: false, tags: ['_N_T_/page'], lastModified, nextCache: 'HIT', ...cache },
    },
    new Request('https://example.netlify.app/page'),
    routed,
  )
  return Object.fromEntries(response.headers)
}

describe('finalize a stored response', () => {
  test('caches a page that is never revalidated for a year', async () => {
    const headers = await finalizeStored(
      { revalidate: false },
      { 'cache-control': 's-maxage=31536000', 'x-next-cache-tags': '_N_T_/page' },
    )
    expect(headers['cache-control']).toBe('public, max-age=0, must-revalidate')
    expect(headers['netlify-cdn-cache-control']).toBe('s-maxage=31536000, durable')
    expect(headers['netlify-cache-tag']).toBe('_N_T_/page')
    expect(headers['cache-status']).toBe('"Next.js"; hit')
    expect(headers.date).toBe('Sat, 10 Oct 2026 12:00:00 GMT')
    expect(headers['x-nextjs-date']).toBeUndefined()
    expect(headers['x-next-cache-tags']).toBeUndefined()
  })

  test('uses revalidate and expire as Next would', async () => {
    const withExpire = await finalizeStored({ revalidate: 60, expire: 360 })
    expect(withExpire['netlify-cdn-cache-control']).toBe(
      's-maxage=60, stale-while-revalidate=300, durable',
    )
    const withoutExpire = await finalizeStored({ revalidate: 60 })
    expect(withoutExpire['netlify-cdn-cache-control']).toBe('s-maxage=60, durable')
  })

  test('a stale response is not cached as fresh', async () => {
    const headers = await finalizeStored({ revalidate: 60, expire: 360, nextCache: 'STALE' })
    expect(headers['netlify-cdn-cache-control']).toBe('public, max-age=0, must-revalidate, durable')
    expect(headers['cache-status']).toBe('"Next.js"; hit; fwd=stale')
  })

  test('a miss has no date from the store', async () => {
    const headers = await finalizeStored({
      revalidate: 60,
      lastModified: undefined,
      nextCache: 'MISS',
    })
    expect(headers.date).toBeUndefined()
    expect(headers['cache-status']).toBe('"Next.js"; fwd=miss')
  })

  test("routing's Cache-Control wins over the store's policy", async () => {
    const headers = await finalizeStored(
      { revalidate: 60 },
      { 'cache-control': 's-maxage=60' },
      (response) => {
        const routedHeaders = new Headers(response.headers)
        routedHeaders.set('cache-control', 'public, max-age=10, s-maxage=20')
        return new Response(response.body, { headers: routedHeaders })
      },
    )
    expect(headers['cache-control']).toBe('public, max-age=10')
    expect(headers['netlify-cdn-cache-control']).toBe('public, max-age=10, s-maxage=20, durable')
  })

  test("a render that couldn't be stored is cached as Next says", async () => {
    const headers = await finalizeStored(
      { revalidate: 0, lastModified: undefined, nextCache: 'MISS' },
      { 'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate' },
    )
    expect(headers['cache-control']).toBe('private, no-cache, no-store, max-age=0, must-revalidate')
    expect(headers['netlify-cdn-cache-control']).toBe(
      'private, no-cache, no-store, max-age=0, must-revalidate, durable',
    )
  })
})
