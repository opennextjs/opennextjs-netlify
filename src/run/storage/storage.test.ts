import { beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeBlobKey } from '../../../tests/utils/helpers.ts'
import { BlobType } from '../../shared/cache-types.cts'
import { createRequestContext, runWithRequestContext } from '../handlers/request-context.cts'

import { getMemoizedKeyValueStoreBackedByRegionalBlobStore } from './storage.cts'

let mockBlobValues: Record<string, unknown> = {}
const mockedStore = {
  get: vi.fn((blobKey) => {
    const key = decodeBlobKey(blobKey)
    return Promise.resolve(mockBlobValues[key])
  }),
  setJSON: vi.fn(async (blobKey, value) => {
    const key = decodeBlobKey(blobKey)
    mockBlobValues[key] = value
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
  revalidatedAt: 123,
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
  mockBlobValues = {
    [TEST_KEY]: TEST_DEFAULT_VALUE,
  }
})
describe('getMemoizedKeyValueStoreBackedByRegionalBlobStore', () => {
  it('is not using in-memory lookups if not running in request context', async () => {
    const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()
    const get1 = await store.get(TEST_KEY, OTEL_SPAN_TITLE)

    expect(mockedStore.get, 'Blobs should be requested').toHaveBeenCalledTimes(1)
    expect(get1, 'Expected blob should be returned').toBe(TEST_DEFAULT_VALUE)

    const get2 = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
    expect(mockedStore.get, 'Blobs should be requested twice').toHaveBeenCalledTimes(2)
    expect(get2, 'Expected second .get to return the same as first one').toBe(get1)
  })

  it('is using in-memory cache when running in request context', async () => {
    await runWithRequestContext(createRequestContext(), async () => {
      const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()

      const get1 = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Blobs should be requested').toHaveBeenCalledTimes(1)
      expect(get1, 'Expected blob should be returned').toBe(TEST_DEFAULT_VALUE)

      const get2 = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Blobs should be requested just once').toHaveBeenCalledTimes(1)
      expect(get2, 'Expected second .get to return the same as first one').toBe(get1)
    })
  })

  it('can read their own writes without checking blobs', async () => {
    await runWithRequestContext(createRequestContext(), async () => {
      const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()

      const writeValue = {
        revalidatedAt: 456,
      } satisfies BlobType

      await store.set(TEST_KEY, writeValue, OTEL_SPAN_TITLE)

      expect(mockedStore.setJSON, 'Blobs should be posted').toHaveBeenCalledTimes(1)

      const get = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Value should be read from memory').toHaveBeenCalledTimes(0)
      expect(get, 'Value from memory should be correct').toBe(writeValue)
    })
  })

  it('is using separate in-memory caches when running in request contexts', async () => {
    const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()
    await runWithRequestContext(createRequestContext(), async () => {
      await store.get(TEST_KEY, OTEL_SPAN_TITLE)
    })

    await runWithRequestContext(createRequestContext(), async () => {
      await store.get(TEST_KEY, OTEL_SPAN_TITLE)
    })

    expect(
      mockedStore.get,
      'Blobs should be requested separately for each request context',
    ).toHaveBeenCalledTimes(2)
  })

  it('writing in one request context should not affect in-memory value in another request context', async () => {
    const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()

    const requestContext1 = createRequestContext()
    const requestContext2 = createRequestContext()

    const writeValue = {
      revalidatedAt: 456,
    } satisfies BlobType

    await runWithRequestContext(requestContext1, async () => {
      const get = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(get, 'Value from memory should be the same as before').toBe(TEST_DEFAULT_VALUE)
      expect(mockedStore.get, 'Blobs should be requested').toHaveBeenCalledTimes(1)
    })

    await runWithRequestContext(requestContext2, async () => {
      mockedStore.get.mockClear()
      await store.set(TEST_KEY, writeValue, OTEL_SPAN_TITLE)
      const get = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Value should be read from memory').toHaveBeenCalledTimes(0)
      expect(get, 'Value from memory should be correct').toBe(writeValue)
    })

    await runWithRequestContext(requestContext1, async () => {
      mockedStore.get.mockClear()
      const get = await store.get(TEST_KEY, OTEL_SPAN_TITLE)
      expect(
        get,
        'Value from memory should be the same as before and not affected by other request context',
      ).toBe(TEST_DEFAULT_VALUE)
      expect(mockedStore.get, 'Value should be read from memory').toHaveBeenCalledTimes(0)
    })
  })

  it('in-memory caches share memory limit (~50MB)', async () => {
    const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore()

    const requestContext1 = createRequestContext()
    const requestContext2 = createRequestContext()

    mockBlobValues = {
      // very heavy values that in-memory caches can only hold one value at a time
      'heavy-route-1': generate30MBBlobTypeValue('1'),
      'heavy-route-2': generate30MBBlobTypeValue('2'),
    }

    await runWithRequestContext(requestContext1, async () => {
      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Value should be read from blobs').toHaveBeenCalledTimes(1)
      mockedStore.get.mockClear()

      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Value should be read from memory').toHaveBeenCalledTimes(0)
      mockedStore.get.mockClear()

      await store.get('heavy-route-2', OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Value should be read from blobs').toHaveBeenCalledTimes(1)
      mockedStore.get.mockClear()

      // at this point we should exceed the memory limit and least recently used value should be evicted
      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(
        mockedStore.get,
        'Previously stored in-memory value should be evicted and fresh value should be read from blobs',
      ).toHaveBeenCalledTimes(1)
      mockedStore.get.mockClear()

      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Value should be read from memory again').toHaveBeenCalledTimes(0)
      mockedStore.get.mockClear()
    })

    await runWithRequestContext(requestContext2, async () => {
      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Value should be read from blobs').toHaveBeenCalledTimes(1)
      mockedStore.get.mockClear()

      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Value should be read from memory').toHaveBeenCalledTimes(0)
      mockedStore.get.mockClear()
    })

    await runWithRequestContext(requestContext1, async () => {
      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      // operations in requestContext2 should result in evicting value for requestContext1
      expect(mockedStore.get, 'Value should be read from blobs').toHaveBeenCalledTimes(1)
      mockedStore.get.mockClear()

      await store.get('heavy-route-1', OTEL_SPAN_TITLE)
      expect(mockedStore.get, 'Value should be read from memory').toHaveBeenCalledTimes(0)
      mockedStore.get.mockClear()
    })
  })
})
