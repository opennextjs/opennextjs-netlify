import { load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { HttpResponse, http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { v4 } from 'uuid'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import {
  createFixture,
  invokeFunction,
  runPlugin,
  type FixtureTestContext,
} from '../utils/fixture.js'
import { generateRandomObjectID, startMockBlobStore } from '../utils/helpers.js'

// Disable the verbose logging of the lambda-local runtime
getLogger().level = 'alert'
let server: ReturnType<typeof setupServer>

beforeAll(() => {
  // Enable API mocking before tests.
  //api.netlify.com/api/v1/purge
  server = setupServer(
    http.all(/^http:\/\/localhost:.*/, () => passthrough()),
    http.all(/^https:\/\/tvproxy.*/, () => passthrough()),
    http.post('https://api.netlify.com/api/v1/purge', () => {
      console.log('intercepted purge api call')
      return HttpResponse.json({})
    }),
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

  expect(staticFetch1.headers?.['cache-tag']).toBe('_N_T_/static/revalidate-manual')
})

test<FixtureTestContext>('Should revalidate path with On-demand Revalidation', async (ctx) => {
  await createFixture('page-router', ctx)
  await runPlugin(ctx)

  const staticPageInitial = await invokeFunction(ctx, { url: '/static/revalidate-manual' })
  const dateCacheInitial = load(staticPageInitial.body)('[data-testid="date-now"]').text()

  expect(staticPageInitial.statusCode).toBe(200)
  expect(staticPageInitial.headers?.['x-nextjs-cache']).toBe('HIT')
  const blobDataInitial = await ctx.blobStore.get('server/pages/static/revalidate-manual', {
    type: 'json',
  })
  const blobDateInitial = load(blobDataInitial.value.html).html('[data-testid="date-now"]')

  const revalidate = await invokeFunction(ctx, { url: '/api/revalidate' })
  expect(revalidate.statusCode).toBe(200)

  await new Promise<void>((resolve) => setTimeout(resolve, 100))

  const blobDataRevalidated = await ctx.blobStore.get('server/pages/static/revalidate-manual', {
    type: 'json',
  })

  const blobDateRevalidated = load(blobDataRevalidated.value.html).html('[data-testid="date-now"]')

  // TODO: Blob data is updated on revalidate but page still producing previous data
  expect(blobDateInitial).not.toBe(blobDateRevalidated)

  const staticPageRevalidated = await invokeFunction(ctx, { url: '/static/revalidate-manual' })
  expect(staticPageRevalidated.headers?.['x-nextjs-cache']).toBe('HIT')
  const dateCacheRevalidated = load(staticPageRevalidated.body)('[data-testid="date-now"]').text()

  console.log({ dateCacheInitial, dateCacheRevalidated })
  expect(dateCacheInitial).not.toBe(dateCacheRevalidated)
})