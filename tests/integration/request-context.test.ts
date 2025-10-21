import { getLogger } from 'lambda-local'
import cjsMock from 'mock-require'
import type { CacheHandler } from 'next/dist/server/lib/incremental-cache/index.js'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { v4 } from 'uuid'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SERVER_HANDLER_NAME } from '../../src/build/plugin-context.js'
import { type FixtureTestContext } from '../utils/contexts.js'
import { createFixture, invokeFunction, runPlugin } from '../utils/fixture.js'
import {
  countOfBlobServerGetsForKey,
  encodeBlobKey,
  generateRandomObjectID,
  startMockBlobStore,
} from '../utils/helpers.js'

// Disable the verbose logging of the lambda-local runtime
getLogger().level = 'alert'

beforeEach<FixtureTestContext>(async (ctx) => {
  // set for each test a new deployID and siteID
  ctx.deployID = generateRandomObjectID()
  ctx.siteID = v4()
  vi.stubEnv('SITE_ID', ctx.siteID)
  vi.stubEnv('DEPLOY_ID', ctx.deployID)
  vi.stubEnv('NETLIFY_PURGE_API_TOKEN', 'fake-token')
  // hide debug logs in tests
  // vi.spyOn(console, 'debug').mockImplementation(() => {})
  await startMockBlobStore(ctx)
  cjsMock.stopAll()
})

function mockCacheHandlerWithPausing(ctx: FixtureTestContext) {
  const locks = new Map<string, (unpause: () => void) => void>()
  async function waitForCacheHandlerGetAndPause(key: string) {
    return new Promise<() => void>((resolve) => {
      locks.set(key, resolve)
    })
  }

  const cacheHandlerPath = realpathSync(
    join(ctx.functionDist, SERVER_HANDLER_NAME, `.netlify/dist/run/handlers/cache.cjs`),
  )
  const CacheHandler = require(cacheHandlerPath).default
  // this is really hacky, but because depending on version Next uses either require or await import
  // and the fact that above require fills module caches, mocking it doesn't seem to work in all cases
  // so instead we mutate the class prototype to do the mocking :yikes:
  const originalGet = CacheHandler.prototype.get
  CacheHandler.prototype.get = async function (...args: Parameters<CacheHandler['get']>) {
    const getWasCalled = locks.get(args[0])

    if (getWasCalled) {
      await new Promise<void>((resolve) => {
        getWasCalled(resolve)
      })
    }
    return originalGet.apply(this, args)
  }

  return {
    waitForCacheHandlerGetAndPause,
  }
}

function spyOnRequestContext(ctx: FixtureTestContext) {
  const requestContextPath = realpathSync(
    join(ctx.functionDist, SERVER_HANDLER_NAME, `.netlify/dist/run/handlers/request-context.cjs`),
  )
  const RequestContextModule = require(requestContextPath)
  const mockedRequestContextModule = {
    ...RequestContextModule,
    getRequestContext: vi.fn(RequestContextModule.getRequestContext),
  }

  cjsMock(requestContextPath, mockedRequestContextModule)

  return mockedRequestContextModule.getRequestContext
}

describe('request-context does NOT leak between concurrent requests', () => {
  test<FixtureTestContext>('pages router', async (ctx) => {
    await createFixture('page-router', ctx)
    await runPlugin(ctx)

    const getRequestContextSpy = spyOnRequestContext(ctx)
    const { waitForCacheHandlerGetAndPause } = mockCacheHandlerWithPausing(ctx)

    // setup we want to ensure that request context is not shared between concurrent requests
    // so we will artificially update `lastModified` timestamps for 2 tested routes
    // so they can be used for assertions
    const mockedDateForRevalidateAutomatic = 'Wed, 01 Jan 2020 00:00:00 GMT'
    const mockedDateForRevalidateSlow = 'Fri, 01 Jan 2021 00:00:00 GMT'

    await ctx.blobStore.setJSON(encodeBlobKey('/static/revalidate-automatic'), {
      ...(await ctx.blobStore.get(encodeBlobKey('/static/revalidate-automatic'), {
        type: 'json',
      })),
      lastModified: new Date(mockedDateForRevalidateAutomatic).getTime(),
    })

    await ctx.blobStore.setJSON(encodeBlobKey('/static/revalidate-slow'), {
      ...(await ctx.blobStore.get(encodeBlobKey('/static/revalidate-slow'), {
        type: 'json',
      })),
      lastModified: new Date(mockedDateForRevalidateSlow).getTime(),
    })

    ctx.blobServerOnRequestSpy.mockClear()

    const waitForCacheHandlerGetAndPausePromise =
      waitForCacheHandlerGetAndPause('/static/revalidate-slow')
    const slowCallPromise = invokeFunction(ctx, {
      url: 'static/revalidate-slow',
    })

    // let /static/revalidate-slow get to the point of getting response cache and pause before actually doing it
    // at this point we didn't yet acquired request context in CacheHandler, so if it's leaking
    // the previous invocation should update wrong context and result should be that
    // we hit blobs fallback to set date
    expect(getRequestContextSpy).toHaveBeenCalledTimes(0)

    const unpauseSlowCall = await waitForCacheHandlerGetAndPausePromise

    // start concurrent request that will finish while first request is paused
    const fastCall = await invokeFunction(ctx, {
      url: 'static/revalidate-automatic',
    })

    // fastCall finished completely so it should have acquired request context
    expect(getRequestContextSpy).toHaveLastReturnedWith(
      expect.objectContaining({
        responseCacheGetLastModified: new Date(mockedDateForRevalidateAutomatic).getTime(),
        responseCacheKey: '/static/revalidate-automatic',
      }),
    )

    // second request finished - now we can unpause the first one
    unpauseSlowCall()

    const slowCall = await slowCallPromise
    // slowCall finished completely so it should have acquired request context
    expect(getRequestContextSpy).toHaveLastReturnedWith(
      expect.objectContaining({
        responseCacheGetLastModified: new Date(mockedDateForRevalidateSlow).getTime(),
        responseCacheKey: '/static/revalidate-slow',
      }),
    )

    expect(slowCall.headers['date']).toBe(mockedDateForRevalidateSlow)
    expect(fastCall.headers['date']).toBe(mockedDateForRevalidateAutomatic)

    // blobs were not used to generate date (we only get blobs inside CacheHandler)
    expect(countOfBlobServerGetsForKey(ctx, '/static/revalidate-slow')).toBe(1)
    expect(countOfBlobServerGetsForKey(ctx, '/static/revalidate-automatic')).toBe(1)
  })

  test<FixtureTestContext>('app router', async (ctx) => {
    await createFixture('server-components', ctx)
    await runPlugin(ctx)

    const getRequestContextSpy = spyOnRequestContext(ctx)
    const { waitForCacheHandlerGetAndPause } = mockCacheHandlerWithPausing(ctx)

    // setup we want to ensure that request context is not shared between concurrent requests
    // so we will artificially update `lastModified` timestamps for 2 tested routes
    // so they can be used for assertions
    const mockedDateForStaticFetch1 = 'Wed, 01 Jan 2020 00:00:00 GMT'
    const mockedDateForStaticFetch2 = 'Fri, 01 Jan 2021 00:00:00 GMT'

    await ctx.blobStore.setJSON(encodeBlobKey('/static-fetch/1'), {
      ...(await ctx.blobStore.get(encodeBlobKey('/static-fetch/1'), {
        type: 'json',
      })),
      lastModified: new Date(mockedDateForStaticFetch1).getTime(),
    })

    await ctx.blobStore.setJSON(encodeBlobKey('/static-fetch/2'), {
      ...(await ctx.blobStore.get(encodeBlobKey('/static-fetch/2'), {
        type: 'json',
      })),
      lastModified: new Date(mockedDateForStaticFetch2).getTime(),
    })

    ctx.blobServerOnRequestSpy.mockClear()

    const waitForCacheHandlerGetAndPausePromise = waitForCacheHandlerGetAndPause('/static-fetch/2')
    const slowCallPromise = invokeFunction(ctx, {
      url: 'static-fetch/2',
    })

    // let /static-fetch/2 get to the point of getting response cache and pause before actually doing it
    // at this point we didn't yet acquired request context in CacheHandler, so if it's leaking
    // the previous invocation should update wrong context and result should be that
    // we hit blobs fallback to set date
    expect(getRequestContextSpy).toHaveBeenCalledTimes(0)

    const unpauseSlowCall = await waitForCacheHandlerGetAndPausePromise

    // start concurrent request that will finish while first request is paused
    const fastCall = await invokeFunction(ctx, {
      url: 'static-fetch/1',
    })

    // fastCall finished completely so it should have acquired request context
    expect(getRequestContextSpy).toHaveLastReturnedWith(
      expect.objectContaining({
        responseCacheGetLastModified: new Date(mockedDateForStaticFetch1).getTime(),
        responseCacheKey: '/static-fetch/1',
      }),
    )

    // second request finished - now we can unpause the first one
    unpauseSlowCall()

    const slowCall = await slowCallPromise
    // slowCall finished completely so it should have acquired request context
    expect(getRequestContextSpy).toHaveLastReturnedWith(
      expect.objectContaining({
        responseCacheGetLastModified: new Date(mockedDateForStaticFetch2).getTime(),
        responseCacheKey: '/static-fetch/2',
      }),
    )

    expect(slowCall.headers['date']).toBe(mockedDateForStaticFetch2)
    expect(fastCall.headers['date']).toBe(mockedDateForStaticFetch1)

    // blobs were not used to generate date (we only get blobs inside CacheHandler)
    expect(countOfBlobServerGetsForKey(ctx, '/static-fetch/2')).toBe(1)
    expect(countOfBlobServerGetsForKey(ctx, '/static-fetch/1')).toBe(1)
  })
})
