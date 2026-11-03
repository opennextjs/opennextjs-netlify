import { load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { v4 } from 'uuid'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TAG_REVALIDATION_MARKER_KEY } from '../../src/run/handlers/tags-handler.cjs'
import { type FixtureTestContext } from '../utils/contexts.js'
import { createFixture, invokeFunction, runPlugin } from '../utils/fixture.js'
import {
  describeBlobServerOperations,
  decodeBlobKeyToRoute,
  generateRandomObjectID,
  getBlobEntries,
  startMockBlobStore,
} from '../utils/helpers.js'
import {
  isExperimentalPPRHardDeprecated,
  nextVersionSatisfies,
  shouldHaveAppRouterGlobalErrorInPrerenderManifest,
  shouldHaveAppRouterNotFoundInPrerenderManifest,
} from '../utils/next-version-helpers.mjs'

// Disable the verbose logging of the lambda-local runtime
getLogger().level = 'alert'

// `ppr` fixture uses `cacheComponents` on Next 16+ (and `experimental.ppr` on older canaries)
const skip = process.env.NEXT_VERSION !== 'canary' && nextVersionSatisfies('<16.0.0')
// https://github.com/vercel/next.js/pull/96297
const hasPartialPrefetchingShellUpgrades = nextVersionSatisfies('>=16.3.0-canary.103')
// https://github.com/vercel/next.js/pull/98612
const neverPrerenderableParamsSkipConcreteLookup = nextVersionSatisfies('>=16.4.0-canary.32')

beforeEach<FixtureTestContext>(async (ctx) => {
  // set for each test a new deployID and siteID
  ctx.deployID = generateRandomObjectID()
  ctx.siteID = v4()
  vi.stubEnv('SITE_ID', ctx.siteID)
  vi.stubEnv('DEPLOY_ID', ctx.deployID)
  // hide debug logs in tests
  vi.spyOn(console, 'debug').mockImplementation(() => {})

  await startMockBlobStore(ctx)
  await createFixture('ppr', ctx)
})

test.skipIf(skip)<FixtureTestContext>(
  'Test that a simple next app with cacheComponents (PPR) is working',
  async (ctx) => {
    await runPlugin(ctx)
    // check if the blob entries were successfully set on the build plugin
    const blobEntries = await getBlobEntries(ctx)
    expect(blobEntries.map(({ key }) => decodeBlobKeyToRoute(key)).sort()).toEqual(
      [
        shouldHaveAppRouterNotFoundInPrerenderManifest() ? undefined : '/404',
        isExperimentalPPRHardDeprecated() ? undefined : '/static-params/[id]',
        shouldHaveAppRouterGlobalErrorInPrerenderManifest() ? '/_global-error' : undefined,
        shouldHaveAppRouterNotFoundInPrerenderManifest() ? '/_not-found' : undefined,
        '/dynamic-params/[id]',
        '/index',
        '/mixed',
        '/static-params/1',
        '/static-params/2',
        '/static-params/[id]',
        '/use-cache',
        '404.html',
        '500.html',
      ].filter(Boolean),
    )

    // test the function call
    const home = await invokeFunction(ctx)
    expect(home.statusCode).toBe(200)
    expect(load(home.body)('h1').text()).toBe('Home')

    const res1 = await invokeFunction(ctx, { url: '/static-params/1' })
    expect(res1.statusCode).toBe(200)
    expect(load(res1.body)('h1').text()).toBe('Dynamic Page (static params): 1')

    const res2 = await invokeFunction(ctx, { url: '/static-params/3' })
    expect(res2.statusCode).toBe(200)
    expect(load(res2.body)('h1').text()).toBe('Dynamic Page (static params): 3')

    const res3 = await invokeFunction(ctx, { url: '/dynamic-params/123' })
    expect(res3.statusCode).toBe(200)
    // on this page, the `await params` is in a Suspense boundary
    expect(load(res3.body)('body').text()).toContain('loading...')
  },
)

describe.skipIf(skip).each([
  { label: 'cacheComponents', partialPrefetching: false },
  ...(hasPartialPrefetchingShellUpgrades
    ? [
        {
          label: 'cacheComponents with partialPrefetching',
          partialPrefetching: true,
          runPluginConstants: { PUBLISH_DIR: '.next-partial-prefetching' },
        },
      ]
    : []),
])('$label', ({ partialPrefetching, runPluginConstants }) => {
  beforeEach<FixtureTestContext>(async (ctx) => {
    await runPlugin(ctx, runPluginConstants)
  })

  // nothing was revalidated, so the marker is a miss and no per-tag manifests are read
  const tagRevalidationMarkerGet = `get ${TAG_REVALIDATION_MARKER_KEY} (miss)`
  // marker is fetched concurrently with the entry so order of blob operations is not stable
  const sorted = (operations: string[]) => [...operations].sort()

  test<FixtureTestContext>('fully static page has no postponed state and is cacheable on CDN', async (ctx) => {
    ctx.blobServerHandleRequestSpy.mockClear()
    const home = await invokeFunction(ctx)
    expect(home.statusCode).toBe(200)
    expect(load(home.body)('h1').text()).toBe('Home')
    expect(sorted(await describeBlobServerOperations(ctx))).toEqual(
      sorted(['get /index (hit)', tagRevalidationMarkerGet]),
    )
    expect(home.headers).toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit',
        'netlify-cdn-cache-control': 's-maxage=31536000, durable',
      }),
    )
    expect(home.headers['x-nextjs-postponed']).toBeUndefined()
  })

  test<FixtureTestContext>('fully "use cache" page has no postponed state and is cacheable on CDN with cacheLife TTL', async (ctx) => {
    const useCacheBlobGets = ['get /use-cache (hit)', tagRevalidationMarkerGet]

    // prerendered pages with TTL are stored as stale so first request triggers background revalidation
    ctx.blobServerHandleRequestSpy.mockClear()
    const stale = await invokeFunction(ctx, { url: '/use-cache' })
    expect(stale.statusCode).toBe(200)
    expect(sorted(await describeBlobServerOperations(ctx))).toEqual(
      sorted([...useCacheBlobGets, 'set /use-cache']),
    )
    expect(stale.headers).toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit; fwd=stale',
        'netlify-cdn-cache-control': 'public, max-age=0, must-revalidate, durable',
      }),
    )
    const staleDate = load(stale.body)('[data-testid="date-now"]').text()

    ctx.blobServerHandleRequestSpy.mockClear()
    const fresh = await invokeFunction(ctx, { url: '/use-cache' })
    expect(fresh.statusCode).toBe(200)
    expect(load(fresh.body)('h1').text()).toBe('Use cache page')
    expect(sorted(await describeBlobServerOperations(ctx))).toEqual(sorted(useCacheBlobGets))
    expect(fresh.headers).toEqual(
      expect.objectContaining({
        'cache-status': '"Next.js"; hit',
        'netlify-cdn-cache-control': 's-maxage=60, stale-while-revalidate=3540, durable',
      }),
    )
    expect(fresh.headers['x-nextjs-postponed']).toBeUndefined()
    expect(
      load(fresh.body)('[data-testid="date-now"]').text(),
      'page should be regenerated in background after stale hit',
    ).not.toBe(staleDate)
  })

  for (const {
    label,
    url,
    h1,
    suspenseFallbackTestId,
    suspenseFallbackTestIdOnRepeatedRequest = suspenseFallbackTestId,
    blobOperations,
    blobOperationsOnRepeatedRequest = blobOperations,
    cachedContentTestId,
  } of [
    {
      label: 'static route with dynamic hole',
      url: '/mixed',
      h1: 'Mixed page',
      suspenseFallbackTestId: 'suspense-fallback',
      // shell has TTL from cacheLife so it is stale on first request and regenerated in background
      blobOperations: ['get /mixed (hit)', tagRevalidationMarkerGet, 'set /mixed'],
      blobOperationsOnRepeatedRequest: ['get /mixed (hit)', tagRevalidationMarkerGet],
      cachedContentTestId: 'cached-date-now',
    },
    {
      label: 'prerendered dynamic route param',
      url: '/static-params/1',
      h1: 'Dynamic Page (static params): 1',
      suspenseFallbackTestId: 'content-suspense-fallback',
      blobOperations: ['get /static-params/1 (hit)', tagRevalidationMarkerGet],
    },
    {
      label: 'not prerendered dynamic route param (fallback shell)',
      url: '/static-params/3',
      h1: 'Dynamic Page (static params): 3',
      // fallback shell does not know params yet, so outer boundary is the one in the shell
      suspenseFallbackTestId: 'params-suspense-fallback',
      // without partialPrefetching shared fallback shell is used and no shell for this param is generated/stored,
      // with it fallback shell is served and upgraded in background to a shell for this param
      blobOperations: [
        'get /static-params/3 (miss)',
        'get /static-params/[id] (hit)',
        tagRevalidationMarkerGet,
        ...(partialPrefetching ? ['set /static-params/3'] : []),
      ],
      blobOperationsOnRepeatedRequest: partialPrefetching
        ? ['get /static-params/3 (hit)', tagRevalidationMarkerGet]
        : undefined,
      // upgraded shell knows params, so only the inner boundary is left
      suspenseFallbackTestIdOnRepeatedRequest: partialPrefetching
        ? 'content-suspense-fallback'
        : undefined,
    },
    {
      label: 'dynamic route without generateStaticParams',
      url: '/dynamic-params/123',
      // param is a promise rendered as a child so it is not in the initial HTML chunk
      h1: 'Dynamic Page (dynamic params):',
      suspenseFallbackTestId: 'suspense-fallback',
      // never prerenderable param is kept out of the cache key (always since Next.js PR 98612,
      // before only with partialPrefetching), so only the shell is looked up
      blobOperations: [
        neverPrerenderableParamsSkipConcreteLookup || partialPrefetching
          ? undefined
          : 'get /dynamic-params/123 (miss)',
        'get /dynamic-params/[id] (hit)',
        tagRevalidationMarkerGet,
      ].filter((operation): operation is string => typeof operation === 'string'),
    },
  ]) {
    test<FixtureTestContext>(`${label} serves shell from blobs, streams dynamic part and is not cacheable on CDN`, async (ctx) => {
      const assertResponse = async (
        expectedBlobOperations: string[],
        expectedSuspenseFallbackTestId: string,
      ) => {
        ctx.blobServerHandleRequestSpy.mockClear()
        const response = await invokeFunction(ctx, { url })
        expect(response.statusCode).toBe(200)
        expect(response.headers).toEqual(
          expect.objectContaining({
            'x-nextjs-postponed': '1',
            'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
            'netlify-cdn-cache-control':
              'private, no-cache, no-store, max-age=0, must-revalidate, durable',
          }),
        )
        expect(sorted(await describeBlobServerOperations(ctx))).toEqual(
          sorted(expectedBlobOperations),
        )

        const $ = load(response.body)
        expect($('h1').text()).toContain(h1)
        expect(
          $(`[data-testid="${expectedSuspenseFallbackTestId}"]`).length,
          'static shell should contain suspense fallback for the dynamic part',
        ).toBe(1)
        return cachedContentTestId ? $(`[data-testid="${cachedContentTestId}"]`).text() : null
      }

      const cachedContent1 = await assertResponse(blobOperations, suspenseFallbackTestId)
      const cachedContent2 = await assertResponse(
        blobOperationsOnRepeatedRequest,
        suspenseFallbackTestIdOnRepeatedRequest,
      )

      if (cachedContentTestId) {
        expect(
          cachedContent2,
          'shell should be regenerated in background after stale hit',
        ).not.toBe(cachedContent1)
        const cachedContent3 = await assertResponse(
          blobOperationsOnRepeatedRequest,
          suspenseFallbackTestIdOnRepeatedRequest,
        )
        expect(cachedContent3, 'regenerated shell should be reused').toBe(cachedContent2)
      }
    }, 60_000)
  }
})
