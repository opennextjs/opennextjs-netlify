import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeBlobKey } from '../../../tests/utils/helpers.ts'
import type { BlobType } from '../../shared/blob-types.cts'

import { createRequestContext, runWithRequestContext } from './request-context.cts'
import {
  getMostRecentTagExpirationTimestamp,
  isAnyTagStaleOrExpired,
  markTagsAsStaleAndPurgeEdgeCache,
  prefetchTagRevalidationMarker,
  TAG_REVALIDATION_MARKER_KEY,
} from './tags-handler.cts'

type StoredBlob = { data: BlobType; etag: string }

const etagFor = (data: BlobType) =>
  `"${createHash('sha256').update(JSON.stringify(data)).digest('hex')}"`

let blobs: Record<string, StoredBlob> = {}

const mockedStore = {
  getWithMetadata: vi.fn((blobKey: string, options?: { etag?: string }) => {
    const key = decodeBlobKey(blobKey)
    const stored = blobs[key]
    if (!stored) {
      return Promise.resolve(null)
    }
    if (options?.etag && options.etag === stored.etag) {
      return Promise.resolve({ data: null, etag: stored.etag })
    }
    return Promise.resolve({ data: stored.data, etag: stored.etag })
  }),
  setJSON: vi.fn(async (blobKey: string, data: BlobType) => {
    const stored = { data, etag: etagFor(data) }
    blobs[decodeBlobKey(blobKey)] = stored
    return { etag: stored.etag, modified: true }
  }),
}

vi.mock('@netlify/blobs', () => ({
  getDeployStore: vi.fn(() => mockedStore),
}))

vi.mock('@netlify/functions', () => ({
  purgeCache: vi.fn(() => Promise.resolve()),
}))

const readKeys = () =>
  mockedStore.getWithMetadata.mock.calls.map(([blobKey]) => decodeBlobKey(blobKey))
const writtenKeys = () => mockedStore.setJSON.mock.calls.map(([blobKey]) => decodeBlobKey(blobKey))

const inRequest = <T>(fn: () => Promise<T>) => runWithRequestContext(createRequestContext(), fn)

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const untypedGlobalThis = globalThis as any
  untypedGlobalThis[Symbol.for('nf-in-memory-lru-cache')] = undefined
  untypedGlobalThis[Symbol.for('nf-tag-revalidation-marker-seen')] = undefined
  blobs = {}
  mockedStore.getWithMetadata.mockClear()
  mockedStore.setJSON.mockClear()
})

describe('tag revalidation marker', () => {
  it('reads nothing but the marker when no tag was ever revalidated', async () => {
    const tags = ['_N_T_/layout', '_N_T_/page', '_N_T_/', 'products']

    const status = await inRequest(() => isAnyTagStaleOrExpired(tags, Date.now()))
    expect(status).toEqual({ stale: false, expired: false })
    expect(readKeys()).toEqual([TAG_REVALIDATION_MARKER_KEY])

    mockedStore.getWithMetadata.mockClear()
    expect(await inRequest(() => getMostRecentTagExpirationTimestamp(tags))).toBe(0)
    expect(readKeys()).toEqual([TAG_REVALIDATION_MARKER_KEY])
  })

  it('writes the marker with the manifests on the first revalidation only', async () => {
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products', 'promo']))
    expect(writtenKeys().sort()).toEqual([TAG_REVALIDATION_MARKER_KEY, 'products', 'promo'])
    expect(blobs[TAG_REVALIDATION_MARKER_KEY].data).toEqual({ revalidatedAt: expect.any(Number) })

    mockedStore.setJSON.mockClear()
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products']))
    expect(writtenKeys()).toEqual(['products'])
  })

  it('checks every tag once the marker exists', async () => {
    const entryTimestamp = Date.now() - 1000
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products']))
    mockedStore.getWithMetadata.mockClear()

    const status = await inRequest(() =>
      isAnyTagStaleOrExpired(['_N_T_/layout', 'products', 'promo'], entryTimestamp),
    )

    expect(status).toEqual({ stale: true, expired: true })
    expect(readKeys()).toContain('products')
    expect(readKeys()).not.toContain(TAG_REVALIDATION_MARKER_KEY)
  })

  it('stops reading the marker once this process has seen it', async () => {
    blobs[TAG_REVALIDATION_MARKER_KEY] = { data: { revalidatedAt: 1 }, etag: '"m"' }

    await inRequest(() => isAnyTagStaleOrExpired(['products'], Date.now()))
    mockedStore.getWithMetadata.mockClear()
    await inRequest(() => isAnyTagStaleOrExpired(['products'], Date.now()))

    expect(readKeys()).toEqual(['products'])
  })

  it('keeps reading the marker while it is absent', async () => {
    await inRequest(() => isAnyTagStaleOrExpired(['products'], Date.now()))
    await inRequest(() => isAnyTagStaleOrExpired(['products'], Date.now()))

    expect(readKeys()).toEqual([TAG_REVALIDATION_MARKER_KEY, TAG_REVALIDATION_MARKER_KEY])
  })

  it('sees a marker written by another instance', async () => {
    await inRequest(() => isAnyTagStaleOrExpired(['products'], Date.now()))
    blobs[TAG_REVALIDATION_MARKER_KEY] = { data: { revalidatedAt: Date.now() }, etag: '"m"' }
    blobs.products = { data: { staleAt: Date.now() + 5, expireAt: Date.now() + 5 }, etag: '"p"' }

    const status = await inRequest(() => isAnyTagStaleOrExpired(['products'], Date.now()))

    expect(status.stale).toBe(true)
  })

  it('returns the expiration from manifests once the marker exists', async () => {
    const before = Date.now()
    await inRequest(() => markTagsAsStaleAndPurgeEdgeCache(['products'], { expire: 60 }))

    const expiration = await inRequest(() =>
      getMostRecentTagExpirationTimestamp(['products', 'never-revalidated']),
    )

    expect(expiration).toBeGreaterThanOrEqual(before + 60_000)
  })

  it('shares the marker read between the prefetch and the tag check', async () => {
    await inRequest(async () => {
      prefetchTagRevalidationMarker()
      await isAnyTagStaleOrExpired(['products'], Date.now())
      await getMostRecentTagExpirationTimestamp(['products'])
    })

    expect(readKeys()).toEqual([TAG_REVALIDATION_MARKER_KEY])
  })
})
