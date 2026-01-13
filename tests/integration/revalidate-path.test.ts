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

test<FixtureTestContext>('should revalidate a route by path', async (ctx) => {
  await createFixture('server-components', ctx)
  await runPlugin(ctx)

  expect(await ctx.blobStore.get(encodeBlobKey('/static-fetch/1'))).not.toBeNull()
  expect(await ctx.blobStore.get(encodeBlobKey('_N_T_/static-fetch/[id]/page'))).toBeNull()

  ctx.blobServerOnRequestSpy.mockClear()

  // test the function call
  const post1 = await invokeFunction(ctx, { url: '/static-fetch/1' })
  const post1Date = load(post1.body)('[data-testid="date-now"]').text()
  expect(post1.statusCode).toBe(200)
  expect(load(post1.body)('h1').text()).toBe('Hello, Statically fetched show 1')
  expect(post1.headers, 'a cache hit on the first invocation of a prerendered page').toEqual(
    expect.objectContaining({
      'cache-status': expect.stringMatching(/"Next.js"; hit/),
      'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
        ? expect.stringMatching(/(s-maxage|max-age)=31536000, durable/)
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    }),
  )

  expect(
    getBlobServerGets(ctx, isTagManifest),
    `expected tag manifests to be retrieved at most once per tag`,
  ).toBeDistinct()
  ctx.blobServerOnRequestSpy.mockClear()

  const post1Route2 = await invokeFunction(ctx, { url: '/static-fetch/2' })
  expect(post1Route2.statusCode).toBe(200)
  expect(post1Route2.headers, 'a cache hit on the first invocation of a prerendered page').toEqual(
    expect.objectContaining({
      'cache-status': expect.stringMatching(/"Next.js"; hit/),
      'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
        ? expect.stringMatching(/(s-maxage|max-age)=31536000, durable/)
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    }),
  )

  expect(
    getBlobServerGets(ctx, isTagManifest),
    `expected tag manifests to be retrieved at most once per tag`,
  ).toBeDistinct()
  ctx.blobServerOnRequestSpy.mockClear()

  const revalidate = await invokeFunction(ctx, { url: '/api/on-demand-revalidate/path' })
  expect(revalidate.statusCode).toBe(200)
  expect(JSON.parse(revalidate.body)).toEqual({ revalidated: true, now: expect.any(String) })
  // expect(calledPurge).toBe(1)
  // it does not wait for the cache.set so we have to manually wait here until the blob storage got populated
  await new Promise<void>((resolve) => setTimeout(resolve, 1000))

  expect(await ctx.blobStore.get(encodeBlobKey('_N_T_/static-fetch/[id]/page'))).not.toBeNull()

  ctx.blobServerOnRequestSpy.mockClear()

  const post2 = await invokeFunction(ctx, { url: '/static-fetch/1' })
  const post2Date = load(post2.body)('[data-testid="date-now"]').text()
  expect(post2.statusCode).toBe(200)
  expect(load(post2.body)('h1').text()).toBe('Hello, Statically fetched show 1')
  expect(post2.headers, 'a cache miss on the on demand revalidated path /1').toEqual(
    expect.objectContaining({
      'cache-status': '"Next.js"; fwd=miss',
      'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
        ? expect.stringMatching(/(max-age|s-maxage)=31536000, durable/)
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    }),
  )
  expect(post2Date).not.toBe(post1Date)

  expect(
    getBlobServerGets(ctx, isTagManifest),
    `expected tag manifests to be retrieved at most once per tag`,
  ).toBeDistinct()
  ctx.blobServerOnRequestSpy.mockClear()

  const post2Route2 = await invokeFunction(ctx, { url: '/static-fetch/2' })

  expect(post2Route2.statusCode).toBe(200)
  expect(post2Route2.headers, 'a cache miss on the on demand revalidated path /2').toEqual(
    expect.objectContaining({
      'cache-status': '"Next.js"; fwd=miss',
      'netlify-cdn-cache-control': nextVersionSatisfies('>=15.0.0-canary.187')
        ? expect.stringMatching(/(max-age|s-maxage)=31536000, durable/)
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    }),
  )

  expect(
    getBlobServerGets(ctx, isTagManifest),
    `expected tag manifests to be retrieved at most once per tag`,
  ).toBeDistinct()
  ctx.blobServerOnRequestSpy.mockClear()
})
