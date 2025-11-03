import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeBlobKey } from '../../../tests/utils/helpers.ts'
import { BlobType } from '../../shared/blob-types.cts'
import { createRequestContext, runWithRequestContext } from '../handlers/request-context.cts'

import { getMemoizedKeyValueStoreBackedByRegionalBlobStore } from './storage.cts'

function mockGenerateRecord(data: BlobType) {
  const etag = `"${createHash('sha256').update(JSON.stringify(data)).digest('hex')}"` as const
  return { data, etag }
}

let mockBlobValues: Record<string, { data: BlobType; etag: string }> = {}
const mockedStore = {
  getWithMetadata: vi.fn((blobKey, options) => {
    const key = decodeBlobKey(blobKey)
    const record = mockBlobValues[key]
    if (record && options?.etag === record.etag) {
      // on etag matches blobs client will return data as null, with etag set
      // indicating that cached value can be reused
      return Promise.resolve({
        data: null,
        etag: record.etag,
      })
    }
    return Promise.resolve(mockBlobValues[key])
  }),
  setJSON: vi.fn(async (blobKey, data) => {
    const key = decodeBlobKey(blobKey)
    const prevValue = mockBlobValues[key]
    const currentValue = mockGenerateRecord(data)

    if (currentValue.etag && prevValue?.etag === currentValue.etag) {
      // no changes
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

const OTEL_SPAN_TITLE = 'test'
const TEST_KEY = 'foo'
const TEST_DEFAULT_VALUE = {
  staleAt: 123,
  expireAt: 456,
} satisfies BlobType

function generate30MBBlobTypeValue(id: string): BlobType {
  return {
    lastModified: Date.now(),
    value: {
      kind: 'ROUTE',
      status: 200,
      headers: {},
      body: `${id}:${'a'.repeat(30 * 1024 * 1024 - id.length - 1)}`,
    },
  }
}

beforeEach(() => {
  // reset in memory cache between tests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unTypedGlobalThis = globalThis as any
  unTypedGlobalThis[Symbol.for('nf-in-memory-lru-cache')] = undefined

  mockBlobValues = {
    [TEST_KEY]: mockGenerateRecord(TEST_DEFAULT_VALUE),
  }
})
describe('getMemoizedKeyValueStoreBackedByRegionalBlobStore', () => {
  it('is not using in-memory lookups if not running in request context', async () => {
    const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()
    const get1 = await store.get(TEST_KEY, OTEL_SPAN_TITLE)

    expect(mockedStore.getWithMetadata, 'Blobs should be requested').toHaveBeenCalledTimes(1)
    expect(get1, 'Expected blob should be returned').toBe(TEST_DEFAULT_VALUE)

    const get2 = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
    expect(mockedStore.getWithMetadata, 'Blobs should be requested twice').toHaveBeenCalledTimes(2)
    expect(get2, 'Expected second .get to return the same as first one').toBe(get1)
  })

  it('is using in-memory cache when running in request context', async () => {
    await runWithRequestContext(createRequestContext(), async () => {
      const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()

      const get1 = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(mockedStore.getWithMetadata, 'Blobs should be requested').toHaveBeenCalledTimes(1)
      expect(get1, 'Expected blob should be returned').toBe(TEST_DEFAULT_VALUE)

      const get2 = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(
        mockedStore.getWithMetadata,
        'Blobs should be requested just once',
      ).toHaveBeenCalledTimes(1)
      expect(get2, 'Expected second .get to return the same as first one').toBe(get1)
    })
  })

  it('can read their own writes without checking blobs', async () => {
    await runWithRequestContext(createRequestContext(), async () => {
      const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()

      const writeValue = {
        staleAt: 456,
        expireAt: 789,
      } satisfies BlobType

      await store.set(TEST_KEY, writeValue, OTEL_SPAN_TITLE)

      expect(mockedStore.setJSON, 'Blobs should be posted').toHaveBeenCalledTimes(1)

      const get = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(mockedStore.getWithMetadata, 'Value should be read from memory').toHaveBeenCalledTimes(
        0,
      )
      expect(get, 'Value from memory should be correct').toBe(writeValue)
    })
  })

  it('does not automatically reuse in-memory values when running in request contexts', async () => {
    const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()
    const get1 = await runWithRequestContext(createRequestContext(), async () => {
      return await store.get(TEST_KEY, OTEL_SPAN_TITLE)
    })

    const get2 = await runWithRequestContext(createRequestContext(), async () => {
      return await store.get(TEST_KEY, OTEL_SPAN_TITLE)
    })

    expect(
      mockedStore.getWithMetadata,
      'Blobs should be requested separately for each request context',
    ).toHaveBeenCalledTimes(2)

    // first request context assertions
    expect(get1, 'store.get in first request should return expected value').toEqual(
      TEST_DEFAULT_VALUE,
    )

    expect(
      mockedStore.getWithMetadata,
      'On first request context, we should not provide etag as we do not have any yet',
    ).toHaveBeenNthCalledWith(1, expect.any(String), {
      etag: undefined,
      type: 'json',
    })

    expect(
      mockedStore.getWithMetadata,
      'should return full value from blobs as it is first time being requested',
    ).toHaveNthResolvedWith(
      1,
      expect.objectContaining({
        data: TEST_DEFAULT_VALUE,
      }),
    )

    // second request context assertions
    expect(get2, 'store.get in second request should return expected value').toEqual(
      TEST_DEFAULT_VALUE,
    )

    expect(
      mockedStore.getWithMetadata,
      'On second request context, we should provide an etag as first request fetched same blob',
    ).toHaveBeenNthCalledWith(2, expect.any(String), {
      etag: expect.any(String),
      type: 'json',
    })

    expect(
      mockedStore.getWithMetadata,
      'On second request context, we should not get blob value, just indication that we can reuse blob',
    ).toHaveNthResolvedWith(
      2,
      expect.objectContaining({
        data: null,
        etag: expect.any(String),
      }),
    )
  })

  it('writing in one request context should not affect in-memory value in another request context', async () => {
    const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()

    const requestContext1 = createRequestContext()
    const requestContext2 = createRequestContext()

    const writeValue = {
      staleAt: 456,
      expireAt: 789,
    } satisfies BlobType

    await runWithRequestContext(requestContext1, async () => {
      const get = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(get, 'Value from memory should be the same as before').toBe(TEST_DEFAULT_VALUE)
      expect(mockedStore.getWithMetadata, 'Blobs should be requested').toHaveBeenCalledTimes(1)
    })

    await runWithRequestContext(requestContext2, async () => {
      mockedStore.getWithMetadata.mockClear()
      await store.set(TEST_KEY, writeValue, OTEL_SPAN_TITLE)
      const get = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(mockedStore.getWithMetadata, 'Value should be read from memory').toHaveBeenCalledTimes(
        0,
      )
      expect(get, 'Value from memory should be correct').toBe(writeValue)
    })

    await runWithRequestContext(requestContext1, async () => {
      mockedStore.getWithMetadata.mockClear()
      const get = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(
        get,
        'Value from memory should be the same as before and not affected by other request context',
      ).toBe(TEST_DEFAULT_VALUE)
      expect(mockedStore.getWithMetadata, 'Value should be read from memory').toHaveBeenCalledTimes(
        0,
      )
    })
  })

  it('in-memory caches share memory limit (~50MB)', async () => {
    const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()

    const requestContext1 = createRequestContext()
    const requestContext2 = createRequestContext()

    mockBlobValues = {
      // very heavy values that in-memory caches can only hold one value at a time
      'heavy-route-1': mockGenerateRecord(generate30MBBlobTypeValue('1')),
      'heavy-route-2': mockGenerateRecord(generate30MBBlobTypeValue('2')),
    }

    await runWithRequestContext(requestContext1, async () => {
      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.getWithMetadata, 'Value should be read from blobs').toHaveBeenCalledTimes(
        1,
      )
      mockedStore.getWithMetadata.mockClear()

      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.getWithMetadata, 'Value should be read from memory').toHaveBeenCalledTimes(
        0,
      )
      mockedStore.getWithMetadata.mockClear()

      await store.get('heavy-route-2', OTEL_SPAN_TITLE)
      expect(mockedStore.getWithMetadata, 'Value should be read from blobs').toHaveBeenCalledTimes(
        1,
      )
      mockedStore.getWithMetadata.mockClear()

      // at this point we should exceed the memory limit and least recently used value should be evicted
      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(
        mockedStore.getWithMetadata,
        'Previously stored in-memory value should be evicted and fresh value should be read from blobs',
      ).toHaveBeenCalledTimes(1)
      mockedStore.getWithMetadata.mockClear()

      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(
        mockedStore.getWithMetadata,
        'Value should be read from memory again',
      ).toHaveBeenCalledTimes(0)
      mockedStore.getWithMetadata.mockClear()
    })

    await runWithRequestContext(requestContext2, async () => {
      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.getWithMetadata, 'Value should be read from blobs').toHaveBeenCalledTimes(
        1,
      )
      mockedStore.getWithMetadata.mockClear()

      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.getWithMetadata, 'Value should be read from memory').toHaveBeenCalledTimes(
        0,
      )
      mockedStore.getWithMetadata.mockClear()
    })

    await runWithRequestContext(requestContext1, async () => {
      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      // operations in requestContext2 should result in evicting value for requestContext1
      expect(mockedStore.getWithMetadata, 'Value should be read from blobs').toHaveBeenCalledTimes(
        1,
      )
      mockedStore.getWithMetadata.mockClear()

      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.getWithMetadata, 'Value should be read from memory').toHaveBeenCalledTimes(
        0,
      )
      mockedStore.getWithMetadata.mockClear()
    })
  })
})
