import { load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { fileURLToPath } from 'node:url'
import { v4 } from 'uuid'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { type FixtureTestContext } from '../utils/contexts.js'
import {
  createFixture,
  invokeFunction,
  loadSandboxedFunction,
  runPlugin,
} from '../utils/fixture.js'
import {
  decodeBlobKey,
  generateRandomObjectID,
  getBlobEntries,
  startMockBlobStore,
} from '../utils/helpers.js'
import {
  hasPartialPrefetching,
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
      '/runtime-prefetchable',
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

  const res4 = await invokeFunction(ctx, { url: '/runtime-prefetchable' })
  expect(res4.statusCode).toBe(200)
  // this page renders `use cache: private` content, which resolves on the server rather
  // than leaving its Suspense fallback in the response
  expect(load(res4.body)('body').text()).toContain('Search params: none')
})

/** Reassembles the RSC flight payload that Next.js inlines into the initial HTML. */
function getInlinedFlightPayload(html: string): string {
  let flight = ''
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g)) {
    flight += JSON.parse(match[1])
  }

  return flight
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * Registers an OpenTelemetry SDK globally, outside the application's `instrumentation.ts`
 * hook, exactly like Netlify's Functions bootstrap does.
 */
const OTEL_BOOTSTRAP = fileURLToPath(new URL('../utils/otel-bootstrap.cjs', import.meta.url))

describe('Cache Components + OpenTelemetry', () => {
  // When an OpenTelemetry SDK is registered, generating a span id calls `Math.random()`, which
  // Next.js treats as synchronous platform IO while prerendering and aborts the runtime
  // prerender. The abort is swallowed, so the page still renders - it just silently loses the
  // runtime prefetch payload that seeds the client segment cache.
  test.skipIf(!hasPartialPrefetching())<FixtureTestContext>(
    'runtime prefetch payload survives when an OpenTelemetry SDK is registered',
    async (ctx) => {
      await createFixture('ppr', ctx)
      await runPlugin(ctx)

      const { invokeFunction: invokeWithOtel } = await loadSandboxedFunction(ctx, {
        env: { NODE_OPTIONS: `--require ${OTEL_BOOTSTRAP}` },
      })

      const response = await invokeWithOtel({ url: '/runtime-prefetchable' })

      expect(response.statusCode).toBe(200)
      expect(
        countOccurrences(getInlinedFlightPayload(response.body), 'cached-content'),
        "'cached-content' to appear twice in the flight payload - once for the rendered page " +
          'portion and once for the runtime prefetch portion that seeds the client segment ' +
          'cache. Getting 1 means the runtime prerender aborted and only the rendered page ' +
          'portion was emitted',
      ).toBe(2)
    },
  )
})
