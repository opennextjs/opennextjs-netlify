import { load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { v4 } from 'uuid'
import { beforeEach, expect, test, vi } from 'vitest'

import { type FixtureTestContext } from '../utils/contexts.js'
import { createFixture, invokeFunction, runPlugin } from '../utils/fixture.js'
import {
  decodeBlobKey,
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

beforeEach<FixtureTestContext>(async (ctx) => {
  // set for each test a new deployID and siteID
  ctx.deployID = generateRandomObjectID()
  ctx.siteID = v4()
  vi.stubEnv('SITE_ID', ctx.siteID)
  vi.stubEnv('DEPLOY_ID', ctx.deployID)
  // hide debug logs in tests
  vi.spyOn(console, 'debug').mockImplementation(() => {})

  await startMockBlobStore(ctx)
})

test.skipIf(
  process.env.NEXT_VERSION !== 'canary' && nextVersionSatisfies('<16.0.0'),
)<FixtureTestContext>('Test that a simple next app with PPR is working', async (ctx) => {
  await createFixture('ppr', ctx)
  await runPlugin(ctx)

  // check if the blob entries were successfully set on the build plugin
  const blobEntries = await getBlobEntries(ctx)
  expect(blobEntries.map(({ key }) => decodeBlobKey(key)).sort()).toEqual(
    [
      shouldHaveAppRouterNotFoundInPrerenderManifest() ? undefined : '/404',
      isExperimentalPPRHardDeprecated() ? undefined : '/static-params/[id]',
      shouldHaveAppRouterGlobalErrorInPrerenderManifest() ? '/_global-error' : undefined,
      shouldHaveAppRouterNotFoundInPrerenderManifest() ? '/_not-found' : undefined,
      '/dynamic-params/[id]',
      '/index',
      '/static-params/1',
      '/static-params/2',
      '/static-params/[id]',
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
})
