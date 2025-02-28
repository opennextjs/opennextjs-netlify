import { load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { HttpResponse, http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { platform } from 'node:process'
import { v4 } from 'uuid'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { type FixtureTestContext } from '../utils/contexts.js'
import { createFixture, invokeFunction, runPlugin } from '../utils/fixture.js'
import { encodeBlobKey, generateRandomObjectID, startMockBlobStore } from '../utils/helpers.js'

// Disable the verbose logging of the lambda-local runtime
getLogger().level = 'alert'
let server: ReturnType<typeof setupServer>

beforeAll(() => {
  // Enable API mocking before tests.
  // mock just api.netlify.com/api/v1/purge
  // and passthrough everything else
  server = setupServer(
    http.post('https://api.netlify.com/api/v1/purge', () => {
      return HttpResponse.json({})
    }),
    http.all(/.*/, () => passthrough()),
  )

  server.listen()
})

beforeEach<FixtureTestContext>(async (ctx) => {
  // set for each test a new deployID and siteID
  ctx.deployID = generateRandomObjectID()
  ctx.siteID = v4()
  vi.stubEnv('SITE_ID', ctx.siteID)
  vi.stubEnv('DEPLOY_ID', ctx.deployID)
  vi.stubEnv('NETLIFY_PURGE_API_TOKEN', 'fake-token')
  // hide debug logs in tests
  vi.spyOn(console, 'debug').mockImplementation(() => {})

  await startMockBlobStore(ctx)
})

afterEach(() => {
  server.resetHandlers()
})

afterAll(() => {
  // Disable API mocking after the tests are done.
  server.close()
})

test<FixtureTestContext>('Should add pathname to cache-tags for pages route', async (ctx) => {
  await createFixture('page-router', ctx)
  await runPlugin(ctx)

  const staticFetch1 = await invokeFunction(ctx, { url: '/static/revalidate-manual' })

  expect(staticFetch1.headers?.['netlify-cache-tag']).toBe('_N_T_/static/revalidate-manual')
})

test<FixtureTestContext>('Should revalidate path with On-demand Revalidation', async (ctx) => {
  await createFixture('page-router', ctx)
  await runPlugin(ctx)

  const staticPageInitial = await invokeFunction(ctx, { url: '/static/revalidate-manual' })
  const dateCacheInitial = load(staticPageInitial.body)('[data-testid="date-now"]').text()

  expect(staticPageInitial.statusCode).toBe(200)
  expect(staticPageInitial.headers?.['cache-status']).toMatch(/"Next.js"; hit/)
  const blobDataInitial = await ctx.blobStore.get(encodeBlobKey('/static/revalidate-manual'), {
    type: 'json',
  })
  const blobDateInitial = load(blobDataInitial.value.html).html('[data-testid="date-now"]')

  const revalidate = await invokeFunction(ctx, { url: '/api/revalidate' })
  expect(revalidate.statusCode).toBe(200)

  await new Promise<void>((resolve) => setTimeout(resolve, 100))

  const blobDataRevalidated = await ctx.blobStore.get(encodeBlobKey('/static/revalidate-manual'), {
    type: 'json',
  })

  const blobDateRevalidated = load(blobDataRevalidated.value.html).html('[data-testid="date-now"]')

  // TODO: Blob data is updated on revalidate but page still producing previous data
  expect(blobDateInitial).not.toBe(blobDateRevalidated)

  const staticPageRevalidated = await invokeFunction(ctx, { url: '/static/revalidate-manual' })
  expect(staticPageRevalidated.headers?.['cache-status']).toMatch(/"Next.js"; hit/)
  const dateCacheRevalidated = load(staticPageRevalidated.body)('[data-testid="date-now"]').text()

  expect(dateCacheInitial).not.toBe(dateCacheRevalidated)
})

test.skipIf(platform === 'win32')<FixtureTestContext>(
  'Should set permanent "netlify-cdn-cache-control" header on fully static pages"',
  async (ctx) => {
    await createFixture('page-router', ctx)
    await runPlugin(ctx)

    const response = await invokeFunction(ctx, {
      url: '/static/fully-static',
    })

    expect(response.headers?.['netlify-cdn-cache-control']).toBe('max-age=31536000, durable')
    expect(response.headers?.['cache-control']).toBe('public, max-age=0, must-revalidate')
  },
)

test<FixtureTestContext>('Should serve correct locale-aware custom 404 pages', async (ctx) => {
  await createFixture('page-router-base-path-i18n', ctx)
  await runPlugin(ctx)

  const responseImplicitDefaultLocale = await invokeFunction(ctx, {
    url: '/base/path/not-existing-page',
  })

  expect(
    responseImplicitDefaultLocale.statusCode,
    'Response for not existing route if locale is not explicitly used in pathname (after basePath) should have 404 status',
  ).toBe(404)
  expect(
    load(responseImplicitDefaultLocale.body)('[data-testid="locale"]').text(),
    'Served 404 page content should use default locale if locale is not explicitly used in pathname (after basePath)',
  ).toBe('en')

  const responseExplicitDefaultLocale = await invokeFunction(ctx, {
    url: '/base/path/en/not-existing-page',
  })

  expect(
    responseExplicitDefaultLocale.statusCode,
    'Response for not existing route if default locale is explicitly used in pathname (after basePath) should have 404 status',
  ).toBe(404)
  expect(
    load(responseExplicitDefaultLocale.body)('[data-testid="locale"]').text(),
    'Served 404 page content should use default locale if default locale is explicitly used in pathname (after basePath)',
  ).toBe('en')

  const responseNonDefaultLocale = await invokeFunction(ctx, {
    url: '/base/path/fr/not-existing-page',
  })

  expect(
    responseNonDefaultLocale.statusCode,
    'Response for not existing route if non-default locale is explicitly used in pathname (after basePath) should have 404 status',
  ).toBe(404)
  expect(
    load(responseNonDefaultLocale.body)('[data-testid="locale"]').text(),
    'Served 404 page content should use non-default locale if non-default locale is explicitly used in pathname (after basePath)',
  ).toBe('fr')
})

// These tests describe how the 404 caching should work, but unfortunately it doesn't work like
// this in v5 and a fix would represent a breaking change so we are skipping them for now, but
// leaving them here for future reference when considering the next major version
describe.skip('404 caching', () => {
  describe('404 without getStaticProps', () => {
    test<FixtureTestContext>('not matching dynamic paths should be cached permanently', async (ctx) => {
      await createFixture('page-router', ctx)
      await runPlugin(ctx)

      const notExistingPage = await invokeFunction(ctx, {
        url: '/not-existing-page',
      })

      expect(notExistingPage.statusCode).toBe(404)

      expect(
        notExistingPage.headers['netlify-cdn-cache-control'],
        'should be cached permanently',
      ).toBe('s-maxage=31536000, stale-while-revalidate=31536000, durable')
    })
    test<FixtureTestContext>('matching dynamic path with revalidate should be cached for revalidate time', async (ctx) => {
      await createFixture('page-router', ctx)
      await runPlugin(ctx)

      const notExistingPage = await invokeFunction(ctx, {
        url: '/products/not-found-with-revalidate',
      })

      expect(notExistingPage.statusCode).toBe(404)

      expect(
        notExistingPage.headers['netlify-cdn-cache-control'],
        'should be cached for revalidate time',
      ).toBe('s-maxage=600, stale-while-revalidate=31536000, durable')
    })
  })

  describe('404 with getStaticProps without revalidate', () => {
    test<FixtureTestContext>('not matching dynamic paths should be cached permanently', async (ctx) => {
      await createFixture('page-router-base-path-i18n', ctx)
      await runPlugin(ctx)

      const notExistingPage = await invokeFunction(ctx, {
        url: '/base/path/not-existing-page',
      })

      expect(notExistingPage.statusCode).toBe(404)

      expect(
        notExistingPage.headers['netlify-cdn-cache-control'],
        'should be cached permanently',
      ).toBe('s-maxage=31536000, stale-while-revalidate=31536000, durable')
    })
    test<FixtureTestContext>('matching dynamic path with revalidate should be cached for revalidate time', async (ctx) => {
      await createFixture('page-router-base-path-i18n', ctx)
      await runPlugin(ctx)

      const notExistingPage = await invokeFunction(ctx, {
        url: '/base/path/products/not-found-with-revalidate',
      })

      expect(notExistingPage.statusCode).toBe(404)

      expect(
        notExistingPage.headers['netlify-cdn-cache-control'],
        'should be cached for revalidate time',
      ).toBe('s-maxage=600, stale-while-revalidate=31536000, durable')
    })
  })

  describe('404 with getStaticProps with revalidate', () => {
    test<FixtureTestContext>('not matching dynamic paths should be cached for 404 page revalidate', async (ctx) => {
      await createFixture('page-router-404-get-static-props-with-revalidate', ctx)
      await runPlugin(ctx)

      // ignoring initial stale case
      await invokeFunction(ctx, {
        url: 'not-existing-page',
      })

      await new Promise((res) => setTimeout(res, 100))

      const notExistingPage = await invokeFunction(ctx, {
        url: 'not-existing-page',
      })

      expect(notExistingPage.statusCode).toBe(404)

      expect(
        notExistingPage.headers['netlify-cdn-cache-control'],
        'should be cached for 404 page revalidate',
      ).toBe('s-maxage=300, stale-while-revalidate=31536000, durable')
    })

    test<FixtureTestContext>('matching dynamic path with revalidate should be cached for revalidate time', async (ctx) => {
      await createFixture('page-router-404-get-static-props-with-revalidate', ctx)
      await runPlugin(ctx)

      // ignoring initial stale case
      await invokeFunction(ctx, {
        url: 'products/not-found-with-revalidate',
      })
      await new Promise((res) => setTimeout(res, 100))

      const notExistingPage = await invokeFunction(ctx, {
        url: 'products/not-found-with-revalidate',
      })

      expect(notExistingPage.statusCode).toBe(404)

      expect(
        notExistingPage.headers['netlify-cdn-cache-control'],
        'should be cached for revalidate time',
      ).toBe('s-maxage=600, stale-while-revalidate=31536000, durable')
    })
  })
})

// This is a temporary fix to ensure that the 404 page itself is cached correctly when requested
// directly. This is a workaround for a specific customer and should be removed once the 404 caching
// is fixed in the next major version.
describe('404 page caching', () => {
  beforeAll(() => {
    process.env.CACHE_404_PAGE = 'true'
  })

  afterAll(() => {
    delete process.env.CACHE_404_PAGE
  })

  test<FixtureTestContext>('404 without getStaticProps', async (ctx) => {
    await createFixture('page-router', ctx)
    await runPlugin(ctx)

    const notExistingPage = await invokeFunction(ctx, {
      url: '/404',
    })

    expect(notExistingPage.statusCode).toBe(404)

    expect(
      notExistingPage.headers['netlify-cdn-cache-control'],
      'should be cached permanently',
    ).toBe('s-maxage=31536000, stale-while-revalidate=31536000, durable')
  })

  test<FixtureTestContext>('404 with getStaticProps without revalidate', async (ctx) => {
    await createFixture('page-router-base-path-i18n', ctx)
    await runPlugin(ctx)

    const notExistingPage = await invokeFunction(ctx, {
      url: '/base/404',
    })

    expect(notExistingPage.statusCode).toBe(404)

    expect(
      notExistingPage.headers['netlify-cdn-cache-control'],
      'should be cached permanently',
    ).toBe('s-maxage=31536000, stale-while-revalidate=31536000, durable')
  })

  test<FixtureTestContext>('404 with getStaticProps with revalidate', async (ctx) => {
    await createFixture('page-router-404-get-static-props-with-revalidate', ctx)
    await runPlugin(ctx)

    // ignoring initial stale case
    await invokeFunction(ctx, {
      url: '/404',
    })

    await new Promise((res) => setTimeout(res, 100))

    const notExistingPage = await invokeFunction(ctx, {
      url: '/404',
    })

    expect(notExistingPage.statusCode).toBe(404)

    expect(
      notExistingPage.headers['netlify-cdn-cache-control'],
      'should be cached for 404 page revalidate',
    ).toBe('s-maxage=300, stale-while-revalidate=31536000, durable')
  })
})
