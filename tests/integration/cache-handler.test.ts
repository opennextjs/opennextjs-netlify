import { load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { v4 } from 'uuid'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { type FixtureTestContext } from '../utils/contexts.js'
import {
  createFixture,
  invokeFunction,
  invokeSandboxedFunction,
  runPlugin,
} from '../utils/fixture.js'
import {
  countOfBlobServerGetsForKey,
  decodeBlobKey,
  encodeBlobKey,
  generateRandomObjectID,
  getBlobEntries,
  startMockBlobStore,
} from '../utils/helpers.js'
import {
  nextVersionSatisfies,
  shouldHaveAppRouterNotFoundInPrerenderManifest,
} from '../utils/next-version-helpers.mjs'

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
})

describe('page router', () => {
  test<FixtureTestContext>('page router with static revalidate', async (ctx) => {
    await createFixture('page-router', ctx)
    console.time('runPlugin')
    await runPlugin(ctx)
    console.timeEnd('runPlugin')
    // check if the blob entries where successful set on the build plugin
    const blobEntries = await getBlobEntries(ctx)
    expect(blobEntries.map(({ key }) => decodeBlobKey(key.substring(0, 50))).sort()).toEqual([
      '/fallback-true/[slug]',
      '/fallback-true/prerendered',
      // the real key is much longer and ends in a hash, but we only assert on the first 50 chars to make it easier
      '/products/an-incredibly-long-product-',
      '/products/prerendered',
      '/products/事前レンダリング,te',
      '/static/revalidate-automatic',
      '/static/revalidate-manual',
      '/static/revalidate-slow',
      '/static/revalidate-slow-data',
      '404.html',
      '500.html',
      'fallback-true/[slug].html',
      'static/fully-static.html',
    ])

    // test the function call
    const call1 = await invokeFunction(ctx, { url: 'static/revalidate-automatic' })
    const call1Date = load(call1.body)('[data-testid="date-now"]').text()
    expect(call1.statusCode).toBe(200)
    expect(load(call1.body)('h1').text()).toBe('Show #71')
    // Prerendered content is always cached as expired, so first invocation will
    // be stale, while fresh is generated in background
    expect(call1.headers, 'a stale page served with swr').toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit; fwd=stale',
        'netlify-cdn-cache-control': 'public, max-age=0, must-revalidate, durable',
      }),
    )

    expect(
      countOfBlobServerGetsForKey(ctx, '/static/revalidate-automatic'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    // wait to have page regenerated in the background
    await new Promise<void>((resolve) => setTimeout(resolve, 1000))

    const call2 = await invokeFunction(ctx, { url: 'static/revalidate-automatic' })
    const call2Date = load(call2.body)('[data-testid="date-now"]').text()
    expect(call2.statusCode).toBe(200)
    expect(load(call2.body)('h1').text()).toBe('Show #71')
    expect(
      call2.headers,
      'fresh page that was generated in background during previous call was served',
    ).toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit',
        'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
          ? `s-maxage=5, stale-while-revalidate=${31536000 - 5}, durable`
          : 's-maxage=5, stale-while-revalidate=31536000, durable',
      }),
    )
    expect(
      call2Date.localeCompare(call1Date),
      'the rendered date in regenerated page is newer than initial stale page',
    ).toBeGreaterThan(0)
    expect(
      new Date(call2.headers['date'].toString()).getTime() -
        new Date(call1.headers['date'].toString()).getTime(),
      'the date header of regenerated page is newer than initial stale page',
    ).toBeGreaterThan(0)

    expect(
      countOfBlobServerGetsForKey(ctx, '/static/revalidate-automatic'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    // ping that should serve the stale page for static/revalidate-slow, while revalidating in background
    await invokeFunction(ctx, { url: 'static/revalidate-slow' })

    expect(
      countOfBlobServerGetsForKey(ctx, '/static/revalidate-slow'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    // wait to have a stale page
    await new Promise<void>((resolve) => setTimeout(resolve, 6_000))

    // Ping this now so we can wait in parallel
    const callLater = await invokeFunction(ctx, { url: 'static/revalidate-slow' })
    expect(
      countOfBlobServerGetsForKey(ctx, '/static/revalidate-slow'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    // over 5 seconds since it was regenerated, so we should get stale response,
    // while fresh is generated in the background
    const call3 = await invokeFunction(ctx, { url: 'static/revalidate-automatic' })
    const call3Date = load(call3.body)('[data-testid="date-now"]').text()
    expect(call3.statusCode).toBe(200)
    expect(call3.headers, 'a stale page served with swr').toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit; fwd=stale',
      }),
    )
    expect(
      call3Date,
      'the rendered date was cached and is matching the initially regenerated one',
    ).toBe(call2Date)
    expect(
      call3.headers['date'],
      'the date header is the same as the initially regenerated one',
    ).toBe(call2.headers['date'])
    expect(
      countOfBlobServerGetsForKey(ctx, '/static/revalidate-automatic'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    // Slow revalidate should still be a hit, but the maxage should be updated
    const callLater2 = await invokeFunction(ctx, { url: 'static/revalidate-slow' })

    expect(callLater2.statusCode).toBe(200)

    expect(callLater2.headers, 'date header matches the cached value').toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit',
        date: callLater.headers['date'],
      }),
    )
    expect(
      countOfBlobServerGetsForKey(ctx, '/static/revalidate-slow'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    // it does not wait for the cache.set so we have to manually wait here until the blob storage got populated
    await new Promise<void>((resolve) => setTimeout(resolve, 1000))

    // now the page should be in cache again and we should get a cache hit
    const call4 = await invokeFunction(ctx, { url: 'static/revalidate-automatic' })
    const call4Date = load(call4.body)('[data-testid="date-now"]').text()
    expect(call4Date, 'the date was not cached').not.toBe(call3Date)
    expect(
      new Date(call4.headers['date'].toString()).getTime() -
        new Date(call3.headers['date'].toString()).getTime(),
      'the date header of regenerated page is newer than initial stale page',
    ).toBeGreaterThan(0)
    expect(call4.statusCode).toBe(200)
    expect(
      call4.headers,
      'a cache hit after dynamically regenerating the stale page in the background',
    ).toEqual(
      expect.objectContaining({
        'cache-status': expect.stringMatching(/"Next.js"; hit/),
      }),
    )
    expect(
      countOfBlobServerGetsForKey(ctx, '/static/revalidate-automatic'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()
  })
})

describe('app router', () => {
  test<FixtureTestContext>('should have a page prerendered, then wait for it to get stale and on demand revalidate it', async (ctx) => {
    await createFixture('revalidate-fetch', ctx)
    console.time('runPlugin')
    await runPlugin(ctx)
    console.timeEnd('runPlugin')
    // check if the blob entries where successful set on the build plugin
    const blobEntries = await getBlobEntries(ctx)
    expect(blobEntries.map(({ key }) => decodeBlobKey(key)).sort()).toEqual(
      [
        '/404',
        shouldHaveAppRouterNotFoundInPrerenderManifest() ? '/_not-found' : undefined,
        '/index',
        '/posts/1',
        '/posts/2',
        '404.html',
        '500.html',
      ].filter(Boolean),
    )

    // test the function call
    const post1 = await invokeFunction(ctx, { url: 'posts/1' })
    const post1Date = load(post1.body)('[data-testid="date-now"]').text()
    expect(post1.statusCode).toBe(200)
    expect(load(post1.body)('h1').text()).toBe('Revalidate Fetch')
    expect(post1.headers, 'a stale response on the first invocation of a prerendered page').toEqual(
      // It will be stale instead of hit
      expect.objectContaining({
        'cache-status': '"Next.js"; hit; fwd=stale',
        'netlify-cdn-cache-control': 'public, max-age=0, must-revalidate, durable',
      }),
    )
    expect(
      countOfBlobServerGetsForKey(ctx, '/posts/1'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    // test a prerendered page without TTL
    const post2 = await invokeFunction(ctx, { url: '/' })
    expect(post2.statusCode).toBe(200)
    expect(post2.headers, 'a stale response on the first invocation of a prerendered page').toEqual(
      // It will be hit instead of stale
      expect.objectContaining({
        'cache-status': '"Next.js"; hit',
        'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
          ? 's-maxage=31536000, durable'
          : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
      }),
    )
    expect(
      countOfBlobServerGetsForKey(ctx, '/index'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    expect(await ctx.blobStore.get(encodeBlobKey('/posts/3'))).toBeNull()
    // this page is not pre-rendered and should result in a cache miss
    const post3 = await invokeFunction(ctx, { url: 'posts/3' })
    expect(post3.statusCode).toBe(200)
    expect(load(post3.body)('h1').text()).toBe('Revalidate Fetch')
    expect(post3.headers, 'a cache miss on a non prerendered page').toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; fwd=miss',
      }),
    )

    // wait to have a stale page
    await new Promise<void>((resolve) => setTimeout(resolve, 6_000))
    // after the dynamic call of `posts/3` it should be in cache, note this is after the timeout as the cache set happens async
    expect(await ctx.blobStore.get(encodeBlobKey('/posts/3'))).not.toBeNull()

    const stale = await invokeFunction(ctx, { url: 'posts/1' })
    const staleDate = load(stale.body)('[data-testid="date-now"]').text()
    expect(stale.statusCode).toBe(200)
    expect(stale.headers, 'a stale swr page is served').toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit; fwd=stale',
      }),
    )
    expect(
      countOfBlobServerGetsForKey(ctx, '/posts/1'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()
    // it should've been regenerated in the background after the first call
    // so the date should be different
    expect(staleDate, 'the date was cached and is matching the initial one').not.toBe(post1Date)

    // it does not wait for the cache.set so we have to manually wait here until the blob storage got populated
    await new Promise<void>((resolve) => setTimeout(resolve, 1000))

    // now the page should be in cache again and we should get a cache hit
    const cached = await invokeFunction(ctx, { url: 'posts/1' })
    const cachedDate = load(cached.body)('[data-testid="date-now"]').text()
    expect(cached.statusCode).toBe(200)
    expect(cachedDate, 'the date is not stale').not.toBe(staleDate)
    expect(
      new Date(cached.headers['date'].toString()).getTime() -
        new Date(post1.headers['date'].toString()).getTime(),
      'the date header of regenerated page is newer than initial stale page',
    ).toBeGreaterThan(0)
    expect(cached.headers, 'a cache hit after dynamically regenerating the stale page').toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit',
      }),
    )
    expect(
      countOfBlobServerGetsForKey(ctx, '/posts/1'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()
  })

  test<FixtureTestContext>("not-prerendered pages should be permanently cached when produced by sandboxed invocations that don't share memory", async (ctx) => {
    await createFixture('server-components', ctx)
    await runPlugin(ctx)

    const blobEntries = await getBlobEntries(ctx)
    // dynamic route that is not pre-rendered should NOT be in the blob store (this is to ensure that test setup is correct)
    expect(blobEntries.map(({ key }) => decodeBlobKey(key))).not.toContain('/static-fetch/3')

    // there is no pre-rendered page for this route, so it should result in a cache miss and blocking render
    const call1 = await invokeSandboxedFunction(ctx, { url: '/static-fetch/3' })
    expect(
      call1.headers['cache-status'],
      'Page should not be in cache yet as this is first time it is being generated',
    ).toBe('"Next.js"; fwd=miss')

    const call1Date = load(call1.body)('[data-testid="date-now"]').text()

    await new Promise((res) => setTimeout(res, 5000))

    const call2 = await invokeSandboxedFunction(ctx, { url: '/static-fetch/3' })
    expect(
      call2.headers['cache-status'],
      'Page should be permanently cached after initial render',
    ).toBe('"Next.js"; hit')

    const call2Date = load(call2.body)('[data-testid="date-now"]').text()
    expect(call2Date, 'Content of response should match').toBe(call1Date)

    await new Promise((res) => setTimeout(res, 5000))

    const call3 = await invokeSandboxedFunction(ctx, { url: '/static-fetch/3' })
    expect(
      call3.headers['cache-status'],
      'Page should be permanently cached after initial render',
    ).toBe('"Next.js"; hit')
    const call3Date = load(call3.body)('[data-testid="date-now"]').text()

    expect(call3Date, 'Content of response should match').toBe(call2Date)
  })
})

describe('plugin', () => {
  test<FixtureTestContext>('server-components blob store created correctly', async (ctx) => {
    await createFixture('server-components', ctx)
    await runPlugin(ctx)
    // check if the blob entries where successful set on the build plugin
    const blobEntries = await getBlobEntries(ctx)
    expect(blobEntries.map(({ key }) => decodeBlobKey(key)).sort()).toEqual(
      [
        '/404',
        shouldHaveAppRouterNotFoundInPrerenderManifest() ? '/_not-found' : undefined,
        '/api/revalidate-handler',
        '/api/static/first',
        '/api/static/second',
        '/api/zero-length-response',
        '/index',
        '/product/事前レンダリング,test',
        '/revalidate-fetch',
        '/static-fetch-1',
        '/static-fetch-2',
        '/static-fetch-3',
        '/static-fetch/1',
        '/static-fetch/2',
        '404.html',
        '500.html',
      ].filter(Boolean),
    )
  })
})

describe('route', () => {
  test<FixtureTestContext>('route handler with cacheable response', async (ctx) => {
    await createFixture('server-components', ctx)
    await runPlugin(ctx)

    // check if the route got prerendered
    const blobEntry = await ctx.blobStore.get(encodeBlobKey('/api/revalidate-handler'), {
      type: 'json',
    })
    expect(blobEntry).not.toBeNull()

    ctx.blobServerGetSpy.mockClear()

    // test the first invocation of the route - we should get stale response while fresh is generated in the background
    const call1 = await invokeFunction(ctx, { url: '/api/revalidate-handler' })
    const call1Body = JSON.parse(call1.body)
    const call1Time = call1Body.time as string
    expect(call1.statusCode).toBe(200)
    expect(call1Body).toMatchObject({
      data: expect.objectContaining({
        id: 1,
        name: 'Under the Dome',
      }),
    })
    expect(call1.headers, 'a stale route served with swr').toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit; fwd=stale',
      }),
    )

    expect(
      countOfBlobServerGetsForKey(ctx, '/api/revalidate-handler'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    // it does not wait for the cache.set so we have to manually wait here until the blob storage got populated
    await new Promise<void>((resolve) => setTimeout(resolve, 1000))

    const call2 = await invokeFunction(ctx, { url: '/api/revalidate-handler' })
    const call2Body = JSON.parse(call2.body)
    const call2Time = call2Body.time as string
    expect(call2.statusCode).toBe(200)
    expect(call2Body).toMatchObject({
      data: expect.objectContaining({
        id: 1,
        name: 'Under the Dome',
      }),
    })
    expect(call2.headers, 'a cache hit on the second invocation').toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit',
      }),
    )
    expect(call2Time.localeCompare(call1Time), 'the rendered date is new').toBeGreaterThan(0)
    expect(
      new Date(call2.headers['date'].toString()).getTime() -
        new Date(call1.headers['date'].toString()).getTime(),
      'the date header of regenerated route is newer than initial stale route',
    ).toBeGreaterThan(0)
    expect(
      countOfBlobServerGetsForKey(ctx, '/api/revalidate-handler'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    // wait to have a stale route again
    await new Promise<void>((resolve) => setTimeout(resolve, 8_000))

    const call3 = await invokeFunction(ctx, { url: '/api/revalidate-handler' })
    const call3Body = JSON.parse(call3.body)
    const call3Time = call3Body.time
    expect(call3.statusCode).toBe(200)
    expect(call3Body).toMatchObject({ data: expect.objectContaining({ id: 1 }) })
    expect(call3.headers, 'a stale route served with swr').toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit; fwd=stale',
      }),
    )
    expect(
      call3Time,
      'the rendered date is the old one on the stale route, while the refresh is happening in the background',
    ).toBe(call2Time)
    expect(call3.headers['date'], 'the date header is the same on stale route').toBe(
      call2.headers['date'],
    )

    expect(
      countOfBlobServerGetsForKey(ctx, '/api/revalidate-handler'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()

    // it does not wait for the cache.set so we have to manually wait here until the blob storage got populated
    await new Promise<void>((resolve) => setTimeout(resolve, 1000))

    const call4 = await invokeFunction(ctx, { url: '/api/revalidate-handler' })
    expect(call4.statusCode).toBe(200)
    const call4Body = JSON.parse(call4.body)
    const call4Time = call4Body.time
    expect(call4Body).toMatchObject({ data: expect.objectContaining({ id: 1 }) })
    expect(call4.headers, 'a cache hit after dynamically regenerating the stale route').toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit',
      }),
    )
    expect(call4Time.localeCompare(call3Time), 'the rendered date is new').toBeGreaterThan(0)
    expect(
      new Date(call4.headers['date'].toString()).getTime() -
        new Date(call3.headers['date'].toString()).getTime(),
      'the date header of regenerated route is newer than previously stale route',
    ).toBeGreaterThan(0)
    expect(
      countOfBlobServerGetsForKey(ctx, '/api/revalidate-handler'),
      'should only try to get value once from blob store (date calculation should not trigger additional blobs.get)',
    ).toBe(1)
    ctx.blobServerGetSpy.mockClear()
  })

  test<FixtureTestContext>('cacheable route handler response not produced at build is served correctly', async (ctx) => {
    await createFixture('server-components', ctx)
    await runPlugin(ctx)

    const call2 = await invokeFunction(ctx, { url: '/api/static/not-in-generateStaticParams' })

    expect(call2.body).toBe('{"params":{"slug":"not-in-generateStaticParams"}}')
  })

  test<FixtureTestContext>('cacheable route handler response with 0 length response is served correctly', async (ctx) => {
    await createFixture('server-components', ctx)
    await runPlugin(ctx)

    const call = await invokeFunction(ctx, { url: '/api/zero-length-response' })

    expect(call.statusCode).toBe(200)
    expect(call.body).toBe('')
  })
})
