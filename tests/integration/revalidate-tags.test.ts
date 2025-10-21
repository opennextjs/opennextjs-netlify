import { load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { v4 } from 'uuid'
import { beforeEach, expect, test, vi } from 'vitest'
import { type FixtureTestContext } from '../utils/contexts.js'
import { createFixture, invokeFunction, runPlugin } from '../utils/fixture.js'
import {
  encodeBlobKey,
  generateRandomObjectID,
  getBlobServerGets,
  startMockBlobStore,
} from '../utils/helpers.js'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'

function isTagManifest(key: string) {
  return key.startsWith('_N_T_')
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

test<FixtureTestContext>('should revalidate a route by tag', async (ctx) => {
  await createFixture('server-components', ctx)
  await runPlugin(ctx)

  expect(await ctx.blobStore.get(encodeBlobKey('/static-fetch-1'))).not.toBeNull()

  ctx.blobServerOnRequestSpy.mockClear()

  // test the function call
  const post1 = await invokeFunction(ctx, { url: '/static-fetch-1' })
  const post1Date = load(post1.body)('[data-testid="date-now"]').text()
  const post1Quote = load(post1.body)('[data-testid="quote"]').text()
  expect(post1.statusCode).toBe(200)
  expect(load(post1.body)('h1').text()).toBe('Hello, Static Fetch 1')
  expect(post1.headers, 'a cache hit on the first invocation of a prerendered page').toEqual(
    expect.objectContaining({
      'cache-status': expect.stringMatching(/"Next.js"; hit/),
      'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
        ? 's-maxage=31536000, durable'
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    }),
  )

  expect(
    getBlobServerGets(ctx, isTagManifest),
    `expected tag manifests to be retrieved at most once per tag`,
  ).toBeDistinct()
  ctx.blobServerOnRequestSpy.mockClear()

  const revalidate = await invokeFunction(ctx, { url: '/api/on-demand-revalidate/tag' })
  expect(revalidate.statusCode).toBe(200)
  expect(JSON.parse(revalidate.body)).toEqual({ revalidated: true, now: expect.any(String) })

  // it does not wait for the revalidation
  await new Promise<void>((resolve) => setTimeout(resolve, 100))

  ctx.blobServerOnRequestSpy.mockClear()

  const post2 = await invokeFunction(ctx, { url: '/static-fetch-1' })
  const post2Date = load(post2.body)('[data-testid="date-now"]').text()
  const post2Quote = load(post2.body)('[data-testid="quote"]').text()
  expect(post2.statusCode).toBe(200)
  expect(load(post2.body)('h1').text()).toBe('Hello, Static Fetch 1')
  expect(post2.headers, 'a cache miss on the on demand revalidated page').toEqual(
    expect.objectContaining({
      'cache-status': '"Next.js"; fwd=miss',
      'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
        ? 's-maxage=31536000, durable'
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    }),
  )
  expect(post2Date).not.toBe(post1Date)
  expect(post2Quote).not.toBe(post1Quote)

  expect(
    getBlobServerGets(ctx, isTagManifest),
    `expected tag manifests to be retrieved at most once per tag`,
  ).toBeDistinct()
  ctx.blobServerOnRequestSpy.mockClear()

  // it does not wait for the cache.set so we have to manually wait here until the blob storage got populated
  await new Promise<void>((resolve) => setTimeout(resolve, 100))

  const post3 = await invokeFunction(ctx, { url: '/static-fetch-1' })
  const post3Date = load(post3.body)('[data-testid="date-now"]').text()
  const post3Quote = load(post3.body)('[data-testid="quote"]').text()
  expect(post3.statusCode).toBe(200)
  expect(load(post3.body)('h1').text()).toBe('Hello, Static Fetch 1')
  expect(post3.headers, 'a cache hit on the revalidated and regenerated page').toEqual(
    expect.objectContaining({
      'cache-status': expect.stringMatching(/"Next.js"; hit/),
      'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
        ? 's-maxage=31536000, durable'
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    }),
  )
  expect(post3Date).toBe(post2Date)
  expect(post3Quote).toBe(post2Quote)

  expect(
    getBlobServerGets(ctx, isTagManifest),
    `expected tag manifests to be retrieved at most once per tag`,
  ).toBeDistinct()
  ctx.blobServerOnRequestSpy.mockClear()

  const revalidate2 = await invokeFunction(ctx, { url: '/api/on-demand-revalidate/tag' })
  expect(revalidate2.statusCode).toBe(200)
  expect(JSON.parse(revalidate2.body)).toEqual({ revalidated: true, now: expect.any(String) })

  // it does not wait for the revalidation
  await new Promise<void>((resolve) => setTimeout(resolve, 100))

  ctx.blobServerOnRequestSpy.mockClear()

  const post4 = await invokeFunction(ctx, { url: '/static-fetch-1' })
  const post4Date = load(post4.body)('[data-testid="date-now"]').text()
  const post4Quote = load(post4.body)('[data-testid="quote"]').text()
  expect(post4.statusCode).toBe(200)
  expect(load(post4.body)('h1').text()).toBe('Hello, Static Fetch 1')
  expect(post4.headers, 'a cache miss on the on demand revalidated page').toEqual(
    expect.objectContaining({
      'cache-status': '"Next.js"; fwd=miss',
      'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
        ? 's-maxage=31536000, durable'
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    }),
  )
  expect(post4Date).not.toBe(post3Date)
  expect(post4Quote).not.toBe(post3Quote)

  expect(
    getBlobServerGets(ctx, isTagManifest),
    `expected tag manifests to be retrieved at most once per tag`,
  ).toBeDistinct()
  ctx.blobServerOnRequestSpy.mockClear()
})
