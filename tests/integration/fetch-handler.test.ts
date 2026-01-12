import { load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { HttpResponse, http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { v4 } from 'uuid'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { type FixtureTestContext } from '../utils/contexts.js'
import { createFixture, invokeFunction, runPlugin, runPluginStep } from '../utils/fixture.js'
import { generateRandomObjectID, getBlobServerGets, startMockBlobStore } from '../utils/helpers.js'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'

function isFetch(key: string) {
  // exclude tag manifests (starting with `_N_T_`), pages (starting with `/`) and static html files (keys including `.html`)
  return !key.startsWith('_N_T_') && !key.startsWith('/') && !key.includes('.html')
}

expect.extend({
  toBeDistinct(received: string[]) {
    const { isNot } = this
    const pass = new Set(received).size === received.length
    return {
      pass,
      message: () => `${received} is${isNot ? ' not' : ''} array with distinct values`,
    }
  },
})

interface CustomMatchers<R = unknown> {
  toBeDistinct(): R
}

declare module 'vitest' {
  interface Assertion<T = any> extends CustomMatchers<T> {}
}

// Disable the verbose logging of the lambda-local runtime
getLogger().level = 'alert'

let handlerCalled = 0
let server: ReturnType<typeof setupServer>

beforeAll(() => {
  // Enable API mocking before tests.
  // mock just https://api.tvmaze.com/shows/:params which is used by tested routes
  // and passthrough everything else
  server = setupServer(
    http.get('https://api.tvmaze.com/shows/:params', () => {
      handlerCalled++
      const date = new Date().toISOString()
      return HttpResponse.json(
        {
          id: '1',
          name: 'Fake response',
          date,
        },
        {
          headers: {
            'cache-control': 'public, max-age=10000',
          },
        },
      )
    }),
    http.all(/.*/, () => passthrough()),
  )

  server.listen()
})

afterAll(() => {
  // Disable API mocking after the tests are done.
  server.close()
})

beforeEach<FixtureTestContext>(async (ctx) => {
  // set for each test a new deployID and siteID
  ctx.deployID = generateRandomObjectID()
  ctx.siteID = v4()
  vi.stubEnv('SITE_ID', ctx.siteID)
  vi.stubEnv('DEPLOY_ID', ctx.deployID)
  // hide debug logs in tests
  // vi.spyOn(console, 'debug').mockImplementation(() => {})

  await startMockBlobStore(ctx)

  handlerCalled = 0
})

test<FixtureTestContext>('if the fetch call is cached correctly (force-dynamic page)', async (ctx) => {
  await createFixture('revalidate-fetch', ctx)
  await runPluginStep(ctx, 'onPreBuild')
  await runPlugin(ctx)

  handlerCalled = 0
  const post1 = await invokeFunction(ctx, {
    url: 'dynamic-posts/1',
  })

  // allow for background regeneration to happen
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  const post1FetchDate = load(post1.body)('[data-testid="date-from-response"]').text()
  const post1Name = load(post1.body)('[data-testid="name"]').text()

  expect(
    handlerCalled,
    'API should be hit as fetch did NOT happen during build for dynamic page',
  ).toBeGreaterThan(0)
  expect(post1.statusCode).toBe(200)
  expect(post1Name).toBe('Fake response')
  expect(post1.headers, 'the page should not be cacheable').toEqual(
    expect.not.objectContaining({
      'cache-status': expect.any(String),
    }),
  )

  handlerCalled = 0
  const post2 = await invokeFunction(ctx, {
    url: 'dynamic-posts/1',
  })

  // allow for any potential background regeneration to happen
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  const post2FetchDate = load(post2.body)('[data-testid="date-from-response"]').text()
  const post2Name = load(post2.body)('[data-testid="name"]').text()

  expect(handlerCalled, 'API should NOT be hit as fetch-cache is still fresh').toBe(0)
  expect(post2FetchDate, 'Cached fetch response should be used').toBe(post1FetchDate)
  expect(post2.statusCode).toBe(200)
  expect(post2Name).toBe('Fake response')
  expect(post2.headers, 'the page should not be cacheable').toEqual(
    expect.not.objectContaining({
      'cache-status': expect.any(String),
    }),
  )

  // make fetch-cache stale
  await new Promise<void>((resolve) => setTimeout(resolve, 7_000))

  handlerCalled = 0
  const post3 = await invokeFunction(ctx, {
    url: 'dynamic-posts/1',
  })

  // allow for any potential background regeneration to happen
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  const post3FetchDate = load(post3.body)('[data-testid="date-from-response"]').text()
  const post3Name = load(post3.body)('[data-testid="name"]').text()

  // note here that we are testing if API was called it least once and not that it was
  // hit exactly once - this is because of Next.js quirk that seems to cause multiple
  // fetch calls being made for single request
  // https://github.com/vercel/next.js/issues/44655
  expect(
    handlerCalled,
    'API should be hit as fetch did go stale and should be revalidated',
  ).toBeGreaterThan(0)
  expect(
    post3FetchDate,
    'Cached fetch response should be used (revalidation happen in background)',
  ).toBe(post1FetchDate)
  expect(post3.statusCode).toBe(200)
  expect(post3Name).toBe('Fake response')
  expect(post3.headers, 'the page should not be cacheable').toEqual(
    expect.not.objectContaining({
      'cache-status': expect.any(String),
    }),
  )

  handlerCalled = 0
  const post4 = await invokeFunction(ctx, {
    url: 'dynamic-posts/1',
  })

  // allow for any potential background regeneration to happen
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  const post4FetchDate = load(post4.body)('[data-testid="date-from-response"]').text()
  const post4Name = load(post4.body)('[data-testid="name"]').text()

  expect(
    handlerCalled,
    'API should NOT be hit as fetch-cache is still fresh after being revalidated in background by previous request',
  ).toBe(0)
  expect(
    post4FetchDate,
    'Response cached in background by previous request should be used',
  ).not.toBe(post3FetchDate)
  expect(post4.statusCode).toBe(200)
  expect(post4Name).toBe('Fake response')
  expect(post4.headers, 'the page should not be cacheable').toEqual(
    expect.not.objectContaining({
      'cache-status': expect.any(String),
    }),
  )
})

test<FixtureTestContext>('if the fetch call is cached correctly (cached page response)', async (ctx) => {
  await createFixture('revalidate-fetch', ctx)
  await runPluginStep(ctx, 'onPreBuild')
  await runPlugin(ctx)

  handlerCalled = 0
  const post1 = await invokeFunction(ctx, {
    url: 'posts/1',
  })

  // allow for background regeneration to happen
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  const post1FetchDate = load(post1.body)('[data-testid="date-from-response"]').text()
  const post1Name = load(post1.body)('[data-testid="name"]').text()

  expect(handlerCalled, 'API should be hit as page was revalidated in background').toBeGreaterThan(
    0,
  )
  expect(post1.statusCode).toBe(200)
  expect(post1Name, 'a stale page served with swr').not.toBe('Fake response')
  expect(post1.headers, 'a stale page served with swr').toEqual(
    expect.objectContaining({
      'cache-status': '"Next.js"; hit; fwd=stale',
      'netlify-cdn-cache-control': 'public, max-age=0, must-revalidate, durable',
    }),
  )

  handlerCalled = 0
  const post2 = await invokeFunction(ctx, {
    url: 'posts/1',
  })

  // allow for any potential background regeneration to happen
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  const post2FetchDate = load(post2.body)('[data-testid="date-from-response"]').text()
  const post2Name = load(post2.body)('[data-testid="name"]').text()

  expect(
    handlerCalled,
    'API should NOT be hit as fetch-cache is still fresh after being revalidated in background by previous request',
  ).toBe(0)
  expect(
    post2FetchDate,
    'Response cached after being revalidated in background should be now used',
  ).not.toBe(post1FetchDate)
  expect(post2.statusCode).toBe(200)
  expect(
    post2Name,
    'Response cached after being revalidated in background should be now used',
  ).toBe('Fake response')
  expect(
    post2.headers,
    'Still fresh response after being regenerated in background by previous request',
  ).toEqual(
    expect.objectContaining({
      'cache-status': '"Next.js"; hit',
      'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
        ? expect.stringMatching(/(s-maxage|max-age)=5, stale-while-revalidate=31535995, durable/)
        : 's-maxage=5, stale-while-revalidate=31536000, durable',
    }),
  )

  // make response and fetch-cache stale
  await new Promise<void>((resolve) => setTimeout(resolve, 7_000))

  handlerCalled = 0
  const post3 = await invokeFunction(ctx, {
    url: 'posts/1',
  })

  // allow for any potential background regeneration to happen
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  const post3FetchDate = load(post3.body)('[data-testid="date-from-response"]').text()
  const post3Name = load(post3.body)('[data-testid="name"]').text()

  // note here that we are testing if API was called it least once and not that it was
  // hit exactly once - this is because of Next.js quirk that seems to cause multiple
  // fetch calls being made for single request
  // https://github.com/vercel/next.js/issues/44655
  expect(
    handlerCalled,
    'API should be hit as fetch did go stale and should be revalidated',
  ).toBeGreaterThan(0)
  expect(
    post3FetchDate,
    'Cached fetch response should be used (revalidation happen in background)',
  ).toBe(post2FetchDate)
  expect(post3.statusCode).toBe(200)
  expect(post3Name).toBe('Fake response')
  expect(post3.headers, 'a stale page served with swr').toEqual(
    expect.objectContaining({
      'cache-status': '"Next.js"; hit; fwd=stale',
      'netlify-cdn-cache-control': 'public, max-age=0, must-revalidate, durable',
    }),
  )

  handlerCalled = 0
  const post4 = await invokeFunction(ctx, {
    url: 'posts/1',
  })

  // allow for any potential background regeneration to happen
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  const post4FetchDate = load(post4.body)('[data-testid="date-from-response"]').text()
  const post4Name = load(post4.body)('[data-testid="name"]').text()

  expect(
    handlerCalled,
    'API should NOT be hit as fetch-cache is still fresh after being revalidated in background by previous request',
  ).toBe(0)
  expect(
    post4FetchDate,
    'Response cached in background by previous request should be used',
  ).not.toBe(post3FetchDate)
  expect(post4.statusCode).toBe(200)
  expect(post4Name).toBe('Fake response')
  expect(
    post4.headers,
    'Still fresh response after being regenerated in background by previous request',
  ).toEqual(
    expect.objectContaining({
      'cache-status': '"Next.js"; hit',
      'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
        ? expect.stringMatching(/(s-maxage|max-age)=5, stale-while-revalidate=31535995, durable/)
        : 's-maxage=5, stale-while-revalidate=31536000, durable',
    }),
  )
})

test<FixtureTestContext>('does not fetch same cached fetch data from blobs twice for the same request', async (ctx) => {
  await createFixture('revalidate-fetch', ctx)
  await runPluginStep(ctx, 'onPreBuild')
  await runPlugin(ctx)

  handlerCalled = 0
  const request1 = await invokeFunction(ctx, {
    url: 'same-fetch-multiple-times/99',
  })

  const request1FetchDate = load(request1.body)('[data-testid="date-from-response"]').text()
  const request1Name = load(request1.body)('[data-testid="name"]').text()

  expect(request1.statusCode, 'Tested page should work').toBe(200)
  expect(request1Name, 'Test setup should use test API mock').toBe('Fake response')

  expect(
    handlerCalled,
    'Cache should be empty, and we should hit mock endpoint once to warm up the cache',
  ).toBe(1)

  const request1FetchCacheKeys = getBlobServerGets(ctx, isFetch)

  expect(
    request1FetchCacheKeys.length,
    'tested page should be doing 3 fetch calls to render single page - we should only try to get cached fetch data from blobs once',
  ).toBe(1)

  const request1AllCacheKeys = getBlobServerGets(ctx)
  expect(
    request1AllCacheKeys,
    'expected blobs for all types of values to be retrieved at most once per key (including fetch data, tag manifests, static files)',
  ).toBeDistinct()

  ctx.blobServerOnRequestSpy.mockClear()
  handlerCalled = 0
  const request2 = await invokeFunction(ctx, {
    url: 'same-fetch-multiple-times/99',
  })

  const request2FetchDate = load(request2.body)('[data-testid="date-from-response"]').text()
  const request2Name = load(request2.body)('[data-testid="name"]').text()

  expect(request2.statusCode, 'Tested page should work').toBe(200)
  expect(request2Name, 'Test setup should use test API mock').toBe('Fake response')
  expect(request2FetchDate, 'Cached fetch data should be used for second request').toBe(
    request1FetchDate,
  )

  expect(handlerCalled, 'Cache should be warm, and we should not hit mock endpoint').toBe(0)

  const request2FetchCacheKeys = getBlobServerGets(ctx, isFetch)

  expect(
    request2FetchCacheKeys.length,
    'We should not reuse in-memory cache from first request and have one fetch blob call for second request',
  ).toBe(1)
  expect(request2FetchCacheKeys, 'Same fetch keys should be used in both requests').toEqual(
    request1FetchCacheKeys,
  )

  const request2AllCacheKeys = getBlobServerGets(ctx)
  expect(
    request2AllCacheKeys,
    'expected blobs for all types of values to be retrieved at most once per key (including fetch data, tag manifests, static files)',
  ).toBeDistinct()
})
