import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeBlobKey } from '../../../tests/utils/helpers.ts'
import type { BlobType } from '../../shared/blob-types.cts'

import { createRequestContext, runWithRequestContext } from './request-context.cts'
import {
  getMostRecentTagExpirationTimestamp,
  isAnyTagStaleOrExpired,
  markTagsAsStaleAndPurgeEdgeCache,
  prefetchTagManifestIndex,
  TAG_MANIFEST_INDEX_KEY,
} from './tags-handler.cts'

type Record_ = { data: BlobType; etag: string }

const etagFor = (data: BlobType) =>
  `"${createHash('sha256').update(JSON.stringify(data)).digest('hex')}"`

let blobs: Record<string, Record_> = {}
// number of conditional writes to fail with `modified: false` before accepting
let conflictsToInject = 0
// when false the store behaves like a server that sends no etag on reads
let etagsOnReads = true

const mockedStore = {
  getWithMetadata: vi.fn((blobKey: string, options?: { etag?: string }) => {
    const key = decodeBlobKey(blobKey)
    const record = blobs[key]
    if (!record) {
      return Promise.resolve(null)
    }
    if (!etagsOnReads) {
      return Promise.resolve({ data: record.data })
    }
    if (options?.etag && options.etag === record.etag) {
      return Promise.resolve({ data: null, etag: record.etag })
    }
    return Promise.resolve({ data: record.data, etag: record.etag })
  }),
  setJSON: vi.fn(
    async (
      blobKey: string,
      data: BlobType,
      options?: { onlyIfMatch?: string; onlyIfNew?: boolean },
    ) => {
      const key = decodeBlobKey(blobKey)
      const prev = blobs[key]
      if (conflictsToInject > 0 && (options?.onlyIfMatch || options?.onlyIfNew)) {
        conflictsToInject -= 1
        return { etag: prev?.etag, modified: false }
      }
      if (options?.onlyIfNew && prev) {
        return { etag: prev.etag, modified: false }
      }
      if (options?.onlyIfMatch && options.onlyIfMatch !== prev?.etag) {
        return { etag: prev?.etag, modified: false }
      }
      const record = { data, etag: etagFor(data) }
      blobs[key] = record
      return { etag: record.etag, modified: true }
    },
  ),
}

vi.mock('@netlify/blobs', () => ({
  getDeployStore: vi.fn(() => mockedStore),
}))

vi.mock('@netlify/functions', () => ({
  purgeCache: vi.fn(() => Promise.resolve()),
}))

const readKeys = () =>
  mockedStore.getWithMetadata.mock.calls.map(([blobKey]) => decodeBlobKey(blobKey))

const inRequest = <T>(fn: () => Promise<T>) => runWithRequestContext(createRequestContext(), fn)

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const untypedGlobalThis = globalThis as any
  untypedGlobalThis[Symbol.for('nf-in-memory-lru-cache')] = undefined
  blobs = {}
  conflictsToInject = 0
  etagsOnReads = true
  mockedStore.getWithMetadata.mockClear()
  mockedStore.setJSON.mockClear()
})

describe('tag manifest index', () => {
  it('reads nothing but the index when no tag was ever revalidated', async () => {
    const status = await inRequest(() =>
      isAnyTagStaleOrExpired(['_N_T_/layout', '_N_T_/page', '_N_T_/', 'products'], Date.now()),
    )

    expect(status).toEqual({ stale: false, expired: false })
    expect(readKeys()).toEqual([TAG_MANIFEST_INDEX_KEY])

    mockedStore.getWithMetadata.mockClear()
    const expiration = await inRequest(() =>
      getMostRecentTagExpirationTimestamp(['_N_T_/layout', 'products']),
    )
    expect(expiration).toBe(0)
    expect(readKeys()).toEqual([TAG_MANIFEST_INDEX_KEY])
  })

  it('writes the index and the manifests when a tag is revalidated', async () => {
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products', 'promo']))

    const written = mockedStore.setJSON.mock.calls.map(([blobKey]) => decodeBlobKey(blobKey))
    expect(written.sort()).toEqual([TAG_MANIFEST_INDEX_KEY, 'products', 'promo'])
    expect(blobs[TAG_MANIFEST_INDEX_KEY].data).toEqual({ tags: { products: 1, promo: 1 } })
  })

  it('reads manifests only for tags present in the index', async () => {
    const entryTimestamp = Date.now() - 1000
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products']))
    mockedStore.getWithMetadata.mockClear()

    const status = await inRequest(() =>
      isAnyTagStaleOrExpired(['_N_T_/layout', '_N_T_/page', 'products', 'promo'], entryTimestamp),
    )

    expect(status).toEqual({ stale: true, expired: true })
    expect(readKeys().sort()).toEqual([TAG_MANIFEST_INDEX_KEY, 'products'])
  })

  it('stays fresh for tags that are indexed but revalidated before the entry', async () => {
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products']))
    const entryTimestamp = Date.now() + 1000

    const status = await inRequest(() => isAnyTagStaleOrExpired(['products'], entryTimestamp))

    expect(status).toEqual({ stale: false, expired: false })
  })

  it('returns the expiration from indexed tags only', async () => {
    const before = Date.now()
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products'], { expire: 60 }))

    const expiration = await inRequest(() =>
      getMostRecentTagExpirationTimestamp(['products', 'never-revalidated']),
    )

    expect(expiration).toBeGreaterThanOrEqual(before + 60_000)
    expect(readKeys()).not.toContain('never-revalidated')
  })

  it('does not rewrite the index when every tag is already listed', async () => {
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products']))
    mockedStore.setJSON.mockClear()

    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products']))

    const written = mockedStore.setJSON.mock.calls.map(([blobKey]) => decodeBlobKey(blobKey))
    expect(written).toEqual(['products'])
  })

  it('retries the index write on a concurrent-write conflict and keeps every tag', async () => {
    conflictsToInject = 2

    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['alpha']))
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['beta']))

    expect(blobs[TAG_MANIFEST_INDEX_KEY].data).toEqual({ tags: { alpha: 1, beta: 1 } })
    const indexWrites = mockedStore.setJSON.mock.calls.filter(
      ([blobKey]) => decodeBlobKey(blobKey) === TAG_MANIFEST_INDEX_KEY,
    )
    // two successful writes plus the two injected conflicts
    expect(indexWrites).toHaveLength(4)
  })

  it('still indexes tags when the store reports no etag on reads', async () => {
    etagsOnReads = false
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products']))
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['promo']))

    expect(blobs[TAG_MANIFEST_INDEX_KEY].data).toEqual({ tags: { products: 1, promo: 1 } })
    const indexWrites = mockedStore.setJSON.mock.calls.filter(
      ([blobKey]) => decodeBlobKey(blobKey) === TAG_MANIFEST_INDEX_KEY,
    )
    // one `onlyIfNew` create, then one unconditional write: no retries
    expect(indexWrites).toHaveLength(2)
    expect(indexWrites[1][2]).toEqual({ span: undefined })
  })

  it('shares the index read between the prefetch and the tag check', async () => {
    await inRequest(async () => {
      prefetchTagManifestIndex()
      await isAnyTagStaleOrExpired(['products'], Date.now())
      await getMostRecentTagExpirationTimestamp(['products'])
    })

    expect(readKeys()).toEqual([TAG_MANIFEST_INDEX_KEY])
  })

  it('sees an index written by another instance through the conditional read', async () => {
    // first request memoizes the (missing) index
    await inRequest(() => isAnyTagStaleOrExpired(['products'], Date.now()))
    // another instance revalidates: index and manifest appear in the store
    blobs[TAG_MANIFEST_INDEX_KEY] = { data: { tags: { products: 1 } }, etag: '"idx"' }
    blobs.products = { data: { staleAt: Date.now() + 5, expireAt: Date.now() + 5 }, etag: '"m"' }

    const status = await inRequest(() => isAnyTagStaleOrExpired(['products'], Date.now()))

    expect(status.stale).toBe(true)
  })
})
