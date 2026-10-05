import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { NEXT_CACHE_TAGS_HEADER } from 'next/dist/lib/constants.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeBlobKey } from '../../../tests/utils/helpers.ts'
import { type BlobType, type TagManifest } from '../../shared/blob-types.cts'
import { type NetlifyCacheHandlerValue } from '../../shared/cache-types.cts'

import { NetlifyCacheHandler } from './cache.cjs'
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
} from './request-context.cjs'

const START = Date.UTC(2026, 0, 1)
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60
const THIRTY_DAYS_MS = THIRTY_DAYS_SECONDS * 1000
const TAG = 'posts'
const READ_AT = START + 10_000

type StoredRecord = { data: BlobType; etag: string }

function mockGenerateRecord(data: BlobType): StoredRecord {
  const etag = `"${createHash('sha256').update(JSON.stringify(data)).digest('hex')}"` as const
  return { data, etag }
}

let mockBlobValues: Record<string, StoredRecord> = {}
const failingTagKeys = new Set<string>()
const servedCacheEntries: NetlifyCacheHandlerValue[] = []

function isCacheEntry(data: BlobType): data is NetlifyCacheHandlerValue {
  return typeof data === 'object' && data !== null && 'lastModified' in data && 'value' in data
}

const mockedStore = {
  getWithMetadata: vi.fn((blobKey: string, options?: { etag?: string }) => {
    const key = decodeBlobKey(blobKey)
    if (failingTagKeys.has(key)) {
      return Promise.reject(new Error(`tag store failure: ${key}`))
    }

    const record = mockBlobValues[key]
    if (!record) {
      return Promise.resolve()
    }

    if (options?.etag === record.etag) {
      // on etag matches blobs client will return data as null, with etag set
      // indicating that cached value can be reused
      return Promise.resolve({
        data: null,
        etag: record.etag,
      })
    }

    // Hand the handler its own clone. Foreground SWR mutates that object, and
    // sharing it with the persisted record would let a later background read
    // observe a negative numeric TTL.
    const data = structuredClone(record.data)
    if (isCacheEntry(data)) {
      servedCacheEntries.push(data)
    }

    return Promise.resolve({
      data,
      etag: record.etag,
    })
  }),
  setJSON: vi.fn(async (blobKey: string, data: BlobType) => {
    const key = decodeBlobKey(blobKey)
    const stored = structuredClone(data)
    const prevValue = mockBlobValues[key]
    const currentValue = mockGenerateRecord(stored)

    if (currentValue.etag && prevValue?.etag === currentValue.etag) {
      return {
        etag: currentValue.etag,
        modified: false,
      }
    }

    mockBlobValues[key] = currentValue

    return {
      etag: currentValue.etag,
      modified: true,
    }
  }),
}

vi.mock('@netlify/blobs', () => {
  return {
    getDeployStore: vi.fn(() => mockedStore),
  }
})

function isolatePersistedRecords() {
  // Request-scoped memory keeps a cross-request weak ref of the last blob.
  // Drop it so each request loads the persisted record, matching a separate
  // invocation. Otherwise a foreground SWR mutation is reused and a background
  // read looks like a numeric-TTL miss.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unTypedGlobalThis = globalThis as any
  unTypedGlobalThis[Symbol.for('nf-in-memory-lru-cache')] = undefined
  servedCacheEntries.length = 0
}

function seedTag(tag: string, staleAt: number, expireAt: number) {
  const manifest = { staleAt, expireAt } satisfies TagManifest
  mockBlobValues[tag] = mockGenerateRecord(manifest)
}

function persistedEntry(key: string): NetlifyCacheHandlerValue {
  const record = mockBlobValues[key]
  if (!record || !isCacheEntry(record.data)) {
    throw new Error(`missing persisted cache entry for ${key}`)
  }
  return record.data
}

function entryRevalidate(entry: NetlifyCacheHandlerValue): number | false | undefined {
  const { value } = entry
  if (value && typeof value === 'object' && 'revalidate' in value) {
    return value.revalidate
  }
  return undefined
}

function requireServedEntry(): NetlifyCacheHandlerValue {
  expect(servedCacheEntries).toHaveLength(1)
  const [served] = servedCacheEntries
  if (!served) {
    throw new Error('expected the request to load one cache entry')
  }
  return served
}

type RenderedKind = 'APP_PAGE' | 'PAGE' | 'PAGES' | 'ROUTE' | 'APP_ROUTE'
type SetValue = NonNullable<Parameters<NetlifyCacheHandler['set']>[1]>
type SetContext = Parameters<NetlifyCacheHandler['set']>[2]
type GetResult = Awaited<ReturnType<NetlifyCacheHandler['get']>>

function renderedEntry(kind: RenderedKind, body: string, tags: string): SetValue {
  const headers = { [NEXT_CACHE_TAGS_HEADER]: tags }
  if (kind === 'APP_PAGE') {
    return {
      kind,
      html: body,
      rscData: Buffer.from(body),
      headers,
      status: 200,
      postponed: undefined,
    }
  }
  if (kind === 'PAGE' || kind === 'PAGES') {
    return {
      kind,
      html: body,
      pageData: { body },
      headers,
      status: 200,
    }
  }
  return {
    kind,
    body: Buffer.from(body),
    status: 200,
    headers,
  }
}

function fetchEntry(body: string, revalidate = THIRTY_DAYS_SECONDS): SetValue {
  return {
    kind: 'FETCH',
    data: {
      headers: { [NEXT_CACHE_TAGS_HEADER]: 'ignored-header-tag' },
      body,
      url: 'https://example.test/api',
      status: 200,
    },
    tags: ['stored-on-value'],
    revalidate,
  }
}

function readBody(value: object): string {
  if ('html' in value && typeof value.html === 'string') {
    return value.html
  }
  if ('body' in value && Buffer.isBuffer(value.body)) {
    return value.body.toString('utf8')
  }
  if ('body' in value && typeof value.body === 'string') {
    return value.body
  }
  if ('data' in value && value.data && typeof value.data === 'object' && 'body' in value.data) {
    return String(value.data.body)
  }
  throw new Error('cache entry has no readable body')
}

function requireHit(result: GetResult) {
  expect(result).not.toBeNull()
  if (!result?.value) {
    throw new Error('expected a cache hit')
  }
  return result
}

function foregroundRequest(requestID: string) {
  return new Request('https://example.test/page', {
    headers: { 'x-nf-request-id': requestID },
  })
}

function backgroundRequest(requestID: string) {
  return new Request('https://example.test/revalidate', {
    headers: {
      'netlify-invocation-source': 'background-revalidation',
      'x-nf-request-id': requestID,
    },
  })
}

async function withIsolatedRequest<T>(request: Request, fn: () => Promise<T>): Promise<T> {
  isolatePersistedRecords()
  return runWithRequestContext(createRequestContext(request), fn)
}

let handler: NetlifyCacheHandler

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: START })
  isolatePersistedRecords()
  mockBlobValues = {}
  failingTagKeys.clear()
  handler = new NetlifyCacheHandler({
    revalidatedTags: [],
    _appDir: true,
    _pagesDir: true,
    _requestHeaders: {},
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const renderedKinds = [
  'APP_PAGE',
  'PAGE',
  'PAGES',
  'ROUTE',
  'APP_ROUTE',
] as const satisfies readonly RenderedKind[]

const ttlModes = [
  {
    name: 'a positive 30-day TTL',
    context: { revalidate: THIRTY_DAYS_SECONDS } satisfies SetContext,
    persistedRevalidate: THIRTY_DAYS_SECONDS as number | false | undefined,
  },
  {
    name: 'revalidate: false',
    context: { revalidate: false } satisfies SetContext,
    persistedRevalidate: false as number | false | undefined,
  },
  {
    name: 'an unset TTL',
    context: {} satisfies SetContext,
    persistedRevalidate: undefined as number | false | undefined,
  },
]

describe('NetlifyCacheHandler tag staleness during background revalidation', () => {
  describe.each(ttlModes)('rendered entries with $name', ({ context, persistedRevalidate }) => {
    it.each(renderedKinds)(
      'misses a stale-but-not-expired %s on background revalidation and serves it stale in the foreground',
      async (kind) => {
        const key = `cache:${kind}`
        const body = `${kind}-body`
        await withIsolatedRequest(foregroundRequest(`set-${kind}`), () =>
          handler.set(key, renderedEntry(kind, body, TAG), context),
        )
        expect(persistedEntry(key).lastModified).toBe(START)
        expect(entryRevalidate(persistedEntry(key))).toBe(persistedRevalidate)

        // Stale at invalidation time, but the tag's expiry is still in the future.
        seedTag(TAG, START + 1_000, START + THIRTY_DAYS_MS)
        vi.setSystemTime(READ_AT)

        await withIsolatedRequest(backgroundRequest(`bg-${kind}`), async () => {
          await expect(handler.get(key)).resolves.toBeNull()
          const requestContext = getRequestContext()
          expect(requestContext?.responseCacheKey).toBeUndefined()
          expect(requestContext?.responseCacheGetLastModified).toBeUndefined()
          expect(requestContext?.responseCacheTags).toBeUndefined()
          expect(requestContext?.isCacheableAppPage).toBeUndefined()
        })

        const served = requireServedEntry()
        expect(served.lastModified).toBe(START)
        expect(entryRevalidate(served)).toBe(persistedRevalidate)
        expect(persistedEntry(key).lastModified).toBe(START)
        expect(entryRevalidate(persistedEntry(key))).toBe(persistedRevalidate)

        await withIsolatedRequest(foregroundRequest(`fg-${kind}`), async () => {
          const hit = requireHit(await handler.get(key))
          expect(hit.lastModified).toBe(READ_AT - 2_000)
          expect(hit.lastModified).not.toBe(-1)
          expect(hit.value).toEqual(
            expect.objectContaining({
              cacheControl: { revalidate: 1, expire: undefined },
            }),
          )
          expect(hit.value).not.toHaveProperty('revalidate')
          expect(readBody(hit.value)).toBe(body)

          const requestContext = getRequestContext()
          expect(requestContext?.responseCacheKey).toBe(key)
          expect(requestContext?.responseCacheGetLastModified).toBe(START)
          expect(requestContext?.responseCacheTags).toEqual([TAG])
          if (kind === 'APP_PAGE') {
            expect(requestContext?.isCacheableAppPage).toBe(true)
          }
        })

        expect(servedCacheEntries[0]?.lastModified).toBe(READ_AT - 2_000)
        expect(persistedEntry(key).lastModified).toBe(START)
        expect(entryRevalidate(persistedEntry(key))).toBe(persistedRevalidate)
      },
    )
  })

  it('regenerates through foreground stale read, background miss, and a later fresh set', async () => {
    const key = 'cache:/blog'
    await withIsolatedRequest(foregroundRequest('set-old'), () =>
      handler.set(key, renderedEntry('APP_PAGE', 'old-body', TAG), {
        revalidate: THIRTY_DAYS_SECONDS,
      }),
    )
    seedTag(TAG, START + 1_000, START + THIRTY_DAYS_MS)

    vi.setSystemTime(READ_AT)
    await withIsolatedRequest(foregroundRequest('fg-stale'), async () => {
      const hit = requireHit(await handler.get(key))
      expect(readBody(hit.value)).toBe('old-body')
      expect(hit.lastModified).toBe(READ_AT - 2_000)
      expect(hit.value).toEqual(
        expect.objectContaining({
          cacheControl: { revalidate: 1, expire: undefined },
        }),
      )
    })

    await withIsolatedRequest(backgroundRequest('bg-miss'), async () => {
      await expect(handler.get(key)).resolves.toBeNull()
    })
    // The background read must see the persisted 30-day entry, not the
    // foreground SWR mutation (revalidate: 1 / lastModified shifted back).
    const served = requireServedEntry()
    expect(served.lastModified).toBe(START)
    expect(entryRevalidate(served)).toBe(THIRTY_DAYS_SECONDS)
    expect(entryRevalidate(persistedEntry(key))).toBe(THIRTY_DAYS_SECONDS)
    expect(persistedEntry(key).lastModified).toBe(START)

    const rewrittenAt = READ_AT + 5_000
    vi.setSystemTime(rewrittenAt)
    await withIsolatedRequest(backgroundRequest('set-new'), () =>
      handler.set(key, renderedEntry('APP_PAGE', 'new-body', TAG), {
        revalidate: THIRTY_DAYS_SECONDS,
      }),
    )
    expect(persistedEntry(key).lastModified).toBe(rewrittenAt)

    await withIsolatedRequest(backgroundRequest('bg-hit'), async () => {
      const hit = requireHit(await handler.get(key))
      expect(readBody(hit.value)).toBe('new-body')
      expect(hit.lastModified).toBe(rewrittenAt)
      expect(hit.value).not.toEqual(
        expect.objectContaining({
          cacheControl: { revalidate: 1, expire: undefined },
        }),
      )
    })

    await withIsolatedRequest(foregroundRequest('fg-hit'), async () => {
      const hit = requireHit(await handler.get(key))
      expect(readBody(hit.value)).toBe('new-body')
      expect(hit.lastModified).toBe(rewrittenAt)
    })
  })

  it('keeps background hits for fresh tags and for unrelated stale tags', async () => {
    const key = 'cache:/fresh'
    await withIsolatedRequest(foregroundRequest('set-fresh'), () =>
      handler.set(key, renderedEntry('APP_PAGE', 'fresh-body', TAG), {
        revalidate: THIRTY_DAYS_SECONDS,
      }),
    )

    seedTag(TAG, START - 5_000, START + THIRTY_DAYS_MS)
    seedTag('unrelated', READ_AT, START + THIRTY_DAYS_MS)
    vi.setSystemTime(READ_AT)

    await withIsolatedRequest(backgroundRequest('bg-fresh'), async () => {
      const hit = requireHit(await handler.get(key))
      expect(readBody(hit.value)).toBe('fresh-body')
      expect(hit.lastModified).toBe(START)
      expect(getRequestContext()?.responseCacheGetLastModified).toBe(START)
    })

    const untaggedKey = 'cache:/untagged'
    await withIsolatedRequest(foregroundRequest('set-untagged'), () =>
      handler.set(untaggedKey, renderedEntry('PAGE', 'untagged-body', 'never-invalidated'), {
        revalidate: THIRTY_DAYS_SECONDS,
      }),
    )
    await withIsolatedRequest(backgroundRequest('bg-untagged'), async () => {
      const hit = requireHit(await handler.get(untaggedKey))
      expect(readBody(hit.value)).toBe('untagged-body')
      expect(hit.lastModified).toBe(READ_AT)
    })
  })

  it('discards a negative numeric TTL on background revalidation before consulting tags', async () => {
    const key = 'cache:/expired-ttl'
    await withIsolatedRequest(foregroundRequest('set-ttl'), () =>
      handler.set(key, renderedEntry('APP_PAGE', 'ttl-body', TAG), { revalidate: 10 }),
    )
    failingTagKeys.add(TAG)
    vi.setSystemTime(START + 20_000)

    await withIsolatedRequest(backgroundRequest('bg-ttl'), async () => {
      await expect(handler.get(key)).resolves.toBeNull()
    })
    expect(
      mockedStore.getWithMetadata.mock.calls.map((call) => decodeBlobKey(call[0])),
    ).not.toContain(TAG)

    failingTagKeys.clear()
    await withIsolatedRequest(foregroundRequest('fg-ttl'), async () => {
      const hit = requireHit(await handler.get(key))
      expect(readBody(hit.value)).toBe('ttl-body')
      expect(hit.lastModified).toBe(START)
    })
  })

  it('misses expired tags, including immediate expiry, on foreground and background requests', async () => {
    const expiredKey = 'cache:/expired'
    const immediateKey = 'cache:/immediate'
    await withIsolatedRequest(foregroundRequest('set-expired'), async () => {
      await handler.set(expiredKey, renderedEntry('APP_PAGE', 'expired-body', 'expired-tag'), {
        revalidate: THIRTY_DAYS_SECONDS,
      })
      await handler.set(immediateKey, renderedEntry('ROUTE', 'immediate-body', 'immediate-tag'), {
        revalidate: false,
      })
    })

    seedTag('expired-tag', START + 1_000, START + 2_000)
    seedTag('immediate-tag', START + 1_000, START + 1_000)
    vi.setSystemTime(START + 1_000)

    await withIsolatedRequest(foregroundRequest('fg-immediate'), async () => {
      await expect(handler.get(immediateKey)).resolves.toBeNull()
    })
    await withIsolatedRequest(backgroundRequest('bg-immediate'), async () => {
      await expect(handler.get(immediateKey)).resolves.toBeNull()
    })

    vi.setSystemTime(START + 60_000)
    await withIsolatedRequest(foregroundRequest('fg-expired'), async () => {
      await expect(handler.get(expiredKey)).resolves.toBeNull()
    })
    await withIsolatedRequest(backgroundRequest('bg-expired'), async () => {
      await expect(handler.get(expiredKey)).resolves.toBeNull()
    })
  })

  it('uses caller tags and softTags for FETCH entries', async () => {
    const key = 'fetch:posts'
    await withIsolatedRequest(foregroundRequest('set-fetch'), () =>
      handler.set(key, fetchEntry('fetch-body'), {
        fetchCache: true,
        revalidate: THIRTY_DAYS_SECONDS,
      }),
    )
    seedTag('caller-stale', START + 1_000, START + THIRTY_DAYS_MS)
    seedTag('soft-stale', START + 1_000, START + THIRTY_DAYS_MS)
    seedTag('stored-on-value', START + 1_000, START + THIRTY_DAYS_MS)
    seedTag('ignored-header-tag', START + 1_000, START + THIRTY_DAYS_MS)
    vi.setSystemTime(READ_AT)

    const fetchContext = {
      fetchUrl: 'https://example.test/api',
      fetchIdx: 0,
    }

    await withIsolatedRequest(backgroundRequest('bg-fetch-fresh'), async () => {
      const hit = requireHit(
        await handler.get(key, {
          ...fetchContext,
          tags: ['caller-fresh'],
          softTags: ['also-fresh'],
        }),
      )
      expect(readBody(hit.value)).toBe('fetch-body')
      expect(hit.lastModified).toBe(START)
    })

    await withIsolatedRequest(backgroundRequest('bg-fetch-tag'), async () => {
      await expect(
        handler.get(key, { ...fetchContext, tags: ['caller-stale'], softTags: ['also-fresh'] }),
      ).resolves.toBeNull()
    })

    await withIsolatedRequest(backgroundRequest('bg-fetch-soft'), async () => {
      await expect(
        handler.get(key, { ...fetchContext, tags: ['caller-fresh'], softTags: ['soft-stale'] }),
      ).resolves.toBeNull()
    })

    await withIsolatedRequest(foregroundRequest('fg-fetch-stale'), async () => {
      const hit = requireHit(await handler.get(key, { ...fetchContext, tags: ['caller-stale'] }))
      expect(hit.lastModified).toBe(-1)
      expect(readBody(hit.value)).toBe('fetch-body')
    })
  })

  it('uses cache-tag headers, not caller tags, for page and route entries', async () => {
    const pageKey = 'cache:/header-page'
    const routeKey = 'cache:/header-route'
    await withIsolatedRequest(foregroundRequest('set-headers'), async () => {
      await handler.set(pageKey, renderedEntry('APP_PAGE', 'page-body', 'alpha%2Cbeta'), {
        revalidate: THIRTY_DAYS_SECONDS,
      })
      await handler.set(routeKey, renderedEntry('APP_ROUTE', 'route-body', 'gamma,delta'), {
        revalidate: THIRTY_DAYS_SECONDS,
      })
    })

    seedTag('beta', START + 1_000, START + THIRTY_DAYS_MS)
    seedTag('caller-stale', START + 1_000, START + THIRTY_DAYS_MS)
    vi.setSystemTime(READ_AT)

    await withIsolatedRequest(backgroundRequest('bg-page-header'), async () => {
      await expect(handler.get(pageKey, { tags: ['caller-fresh'] })).resolves.toBeNull()
    })

    await withIsolatedRequest(backgroundRequest('bg-route-caller'), async () => {
      const hit = requireHit(await handler.get(routeKey, { tags: ['caller-stale'] }))
      expect(readBody(hit.value)).toBe('route-body')
      expect(hit.lastModified).toBe(START)
    })

    seedTag('delta', START + 1_000, START + THIRTY_DAYS_MS)
    await withIsolatedRequest(backgroundRequest('bg-route-header'), async () => {
      await expect(handler.get(routeKey, { tags: ['caller-fresh'] })).resolves.toBeNull()
    })
  })

  it('returns null when the blob is missing', async () => {
    await withIsolatedRequest(foregroundRequest('fg-miss'), async () => {
      await expect(handler.get('cache:/missing')).resolves.toBeNull()
    })
    await withIsolatedRequest(backgroundRequest('bg-miss'), async () => {
      await expect(handler.get('cache:/missing')).resolves.toBeNull()
    })
  })

  it('propagates tag-store failures instead of serving the entry as fresh', async () => {
    const key = 'cache:/tag-error'
    await withIsolatedRequest(foregroundRequest('set-tag-error'), () =>
      handler.set(key, renderedEntry('APP_PAGE', 'hidden-body', TAG), {
        revalidate: THIRTY_DAYS_SECONDS,
      }),
    )
    failingTagKeys.add(TAG)
    vi.setSystemTime(READ_AT)

    await withIsolatedRequest(foregroundRequest('fg-tag-error'), async () => {
      await expect(handler.get(key)).rejects.toThrow(`tag store failure: ${TAG}`)
    })
    await withIsolatedRequest(backgroundRequest('bg-tag-error'), async () => {
      await expect(handler.get(key)).rejects.toThrow(`tag store failure: ${TAG}`)
    })
  })
})
