import { CheerioAPI, load } from 'cheerio'
import { getLogger } from 'lambda-local'
import { v4 } from 'uuid'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { type FixtureTestContext } from '../utils/contexts.js'
import { createFixture, loadSandboxedFunction, runPlugin } from '../utils/fixture.js'
import { generateRandomObjectID, startMockBlobStore } from '../utils/helpers.js'
import { InvokeFunctionResult } from '../utils/lambda-helpers.mjs'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'
import { afterTestCleanup } from '../test-setup.js'

function compareDates(
  $response1: CheerioAPI,
  $response2: CheerioAPI,
  testid: string,
  shouldBeEqual: boolean,
  diffHelper: (a: string, b: string) => string | undefined,
) {
  const selector = `[data-testid="${testid}"]`

  const data1 = $response1(selector).text()
  const data2 = $response2(selector).text()

  if (!data1 || !data2) {
    return {
      isExpected: false,
      msg: `Missing or empty data-testid="${testid}" in one of the responses`,
    }
  }

  const isEqual = data1 === data2
  const isExpected = isEqual === shouldBeEqual

  return {
    isExpected,
    msg: isExpected
      ? null
      : shouldBeEqual
        ? `Expected ${testid} to be equal, but got different values:\n${diffHelper(data1, data2)}`
        : `Expected ${testid} NOT to be equal, but got same value: "${data1}`,
  }
}

type ExpectedCachingBehaviorDefinition = {
  getDataTimeShouldBeEqual: boolean
  resultWrapperComponentTimeShouldBeEqual: boolean
  pageComponentTimeShouldBeEqual: boolean
}

expect.extend({
  toBeCacheableResponse(response: Awaited<InvokeFunctionResult>) {
    const netlifyCacheControlHeader = response.headers['netlify-cdn-cache-control']

    if (typeof netlifyCacheControlHeader !== 'string') {
      return {
        pass: false,
        message: () =>
          `Expected 'netlify-cdn-cache-control' response header to be a string. Got ${netlifyCacheControlHeader} (${typeof netlifyCacheControlHeader}).`,
      }
    }

    const isCacheable = Boolean(netlifyCacheControlHeader.match(/(max-age|s-maxage)(?!=0)/))

    return {
      pass: isCacheable,
      message: () =>
        `Expected ${netlifyCacheControlHeader} to${this.isNot ? ' not' : ''} be cacheable`,
    }
  },
  toHaveResponseCacheTag(response: Awaited<InvokeFunctionResult>, tag: string) {
    const netlifyCacheTag = response.headers['netlify-cache-tag']
    if (typeof netlifyCacheTag !== 'string') {
      return {
        pass: false,
        message: () =>
          `Expected 'netlify-cache-tag' response header to be a string. Got ${netlifyCacheTag} (${typeof netlifyCacheTag}).`,
      }
    }
    const containsTag = Boolean(netlifyCacheTag.split(',').find((t) => t.trim() === tag))

    return {
      pass: containsTag,
      message: () => `Expected ${netlifyCacheTag} to${this.isNot ? ' not' : ''} have "${tag}" tag`,
    }
  },
  toHaveExpectedCachingBehavior(
    response1: Awaited<InvokeFunctionResult>,
    response2: Awaited<InvokeFunctionResult>,
    {
      getDataTimeShouldBeEqual,
      resultWrapperComponentTimeShouldBeEqual,
      pageComponentTimeShouldBeEqual,
    }: ExpectedCachingBehaviorDefinition,
  ) {
    const $response1 = load(response1.body)
    const $response2 = load(response2.body)

    const getDataComparison = compareDates(
      $response1,
      $response2,
      'getData-time',
      getDataTimeShouldBeEqual,
      this.utils.diff,
    )
    const resultComponentComparison = compareDates(
      $response1,
      $response2,
      'ResultWrapperComponent-time',
      resultWrapperComponentTimeShouldBeEqual,
      this.utils.diff,
    )
    const pageComponentComparison = compareDates(
      $response1,
      $response2,
      'PageComponent-time',
      pageComponentTimeShouldBeEqual,
      this.utils.diff,
    )

    return {
      pass:
        getDataComparison.isExpected &&
        resultComponentComparison.isExpected &&
        pageComponentComparison.isExpected,
      message: () =>
        [getDataComparison.msg, resultComponentComparison.msg, pageComponentComparison.msg]
          .filter(Boolean)
          .join('\n\n'),
    }
  },
})

interface CustomMatchers<R = unknown> {
  toBeCacheableResponse(): R
  toHaveResponseCacheTag(tag: string): R
  toHaveExpectedCachingBehavior(
    response2: Awaited<InvokeFunctionResult>,
    expectations: ExpectedCachingBehaviorDefinition,
  ): R
}

declare module 'vitest' {
  interface Assertion<T = any> extends CustomMatchers<T> {}
}

// Disable the verbose logging of the lambda-local runtime
getLogger().level = 'alert'

// only supporting latest variant (https://github.com/vercel/next.js/pull/76687)
// first released in v15.3.0-canary.13 so we should not run tests on older next versions
describe.skipIf(!nextVersionSatisfies('>=15.3.0-canary.13'))('use cache', () => {
  // note that in this test suite we are setting up test fixture once
  // because every test is using different path and also using sandboxed functions
  // so tests are not sharing context between them and this make test running
  // much more performant
  let ctx: FixtureTestContext
  beforeAll(async () => {
    console.log(`[${new Date().toISOString()}] Starting use-cache beforeAll`)
    try {
      ctx = {
        deployID: generateRandomObjectID(),
        siteID: v4(),
      } as FixtureTestContext
      ctx.debug = true

      vi.stubEnv('SITE_ID', ctx.siteID)
      vi.stubEnv('DEPLOY_ID', ctx.deployID)
      vi.stubEnv('NETLIFY_PURGE_API_TOKEN', 'fake-token')
      await startMockBlobStore(ctx as FixtureTestContext)

      await createFixture('use-cache', ctx)
      await runPlugin(ctx)
      console.log(`[${new Date().toISOString()}] Finished use-cache beforeAll`)
    } catch (err) {
      console.log(`[${new Date().toISOString()}] use-cache beforeAll failed`, err)
      throw err
    }
  })

  afterAll(async () => {
    console.log(`[${new Date().toISOString()}] Finished use-cache afterAll`)
    try {
      await afterTestCleanup(ctx)
      console.log(`[${new Date().toISOString()}] Finished use-cache afterAll`)
    } catch (err) {
      console.log(`[${new Date().toISOString()}] use-cache afterAll failed`, err)
      throw err
    }
  })

  describe('default (in-memory cache entries, shared tag manifests)', () => {
    for (const {
      expectedCachingBehaviorWhenUseCacheRegenerates,
      useCacheLocationLabel,
      useCacheLocationPathSegment,
      useCacheTagPrefix,
    } of [
      {
        useCacheLocationLabel: "'use cache' in data fetching function",
        useCacheLocationPathSegment: 'use-cache-data',
        useCacheTagPrefix: 'data',
        expectedCachingBehaviorWhenUseCacheRegenerates: {
          // getData function has 'use cache' so it should report same generation time, everything else is dynamically regenerated on each request
          getDataTimeShouldBeEqual: true,
          resultWrapperComponentTimeShouldBeEqual: false,
          pageComponentTimeShouldBeEqual: false,
        },
      },
      {
        useCacheLocationLabel: "'use cache' in react non-page component",
        useCacheLocationPathSegment: 'use-cache-component',
        useCacheTagPrefix: 'component',
        expectedCachingBehaviorWhenUseCacheRegenerates: {
          // <ResultWrapperComponent> has 'use cache' so it should report same generation time, everything else is dynamically regenerated on each request
          getDataTimeShouldBeEqual: false,
          resultWrapperComponentTimeShouldBeEqual: true,
          pageComponentTimeShouldBeEqual: false,
        },
      },
      {
        useCacheLocationLabel: "'use cache' in react page component",
        useCacheLocationPathSegment: 'use-cache-page',
        useCacheTagPrefix: 'page',
        expectedCachingBehaviorWhenUseCacheRegenerates: {
          // <PageComponent> has 'use cache' so it should report same generation time for everything as this is entry point
          getDataTimeShouldBeEqual: true,
          resultWrapperComponentTimeShouldBeEqual: true,
          pageComponentTimeShouldBeEqual: true,
        },
      },
    ]) {
      describe(useCacheLocationLabel, () => {
        describe('dynamic page (not using response cache)', () => {
          describe('TTL=1 year', () => {
            const routeRoot = `default/${useCacheLocationPathSegment}/dynamic/ttl-1year`

            test<FixtureTestContext>('subsequent invocations on same lambda return same result', async () => {
              const url = `${routeRoot}/same-lambda`

              const { invokeFunction } = await loadSandboxedFunction(ctx)

              const call1 = await invokeFunction({ url })
              expect(call1).not.toBeCacheableResponse()

              const call2 = await invokeFunction({ url })
              expect(call2).toHaveExpectedCachingBehavior(
                call1,
                expectedCachingBehaviorWhenUseCacheRegenerates,
              )
            })

            test<FixtureTestContext>('tag invalidation works on same lambda', async () => {
              const url = `${routeRoot}/same-lambda-tag-invalidation`

              const { invokeFunction } = await loadSandboxedFunction(ctx)

              const call1 = await invokeFunction({ url })
              expect(call1).not.toBeCacheableResponse()

              await invokeFunction({ url: `/api/revalidate/${useCacheTagPrefix}/${url}` })

              const call2 = await invokeFunction({ url })
              expect(call2).toHaveExpectedCachingBehavior(call1, {
                // getData function has 'use cache', but it was on-demand revalidated so everything should be fresh
                getDataTimeShouldBeEqual: false,
                resultWrapperComponentTimeShouldBeEqual: false,
                pageComponentTimeShouldBeEqual: false,
              })
            })

            test<FixtureTestContext>('invocations on different lambdas return different results', async () => {
              const url = `${routeRoot}/different-lambdas`

              const { invokeFunction: invokeFunctionLambda1 } = await loadSandboxedFunction(ctx)
              const { invokeFunction: invokeFunctionLambda2 } = await loadSandboxedFunction(ctx)

              const call1 = await invokeFunctionLambda1({ url })
              expect(call1).not.toBeCacheableResponse()

              const call2 = await invokeFunctionLambda2({ url })
              expect(call2).toHaveExpectedCachingBehavior(call1, {
                // default cache is in-memory so we expect lambdas not to share data
                getDataTimeShouldBeEqual: false,
                resultWrapperComponentTimeShouldBeEqual: false,
                pageComponentTimeShouldBeEqual: false,
              })
            })

            test<FixtureTestContext>('invalidating tag on one lambda result in invalidating them on all lambdas', async () => {
              const url = `${routeRoot}/different-lambdas-tag-invalidation`

              const { invokeFunction: invokeFunctionLambda1 } = await loadSandboxedFunction(ctx)
              const { invokeFunction: invokeFunctionLambda2 } = await loadSandboxedFunction(ctx)

              const call1 = await invokeFunctionLambda1({ url })
              expect(call1).not.toBeCacheableResponse()

              await invokeFunctionLambda2({ url: `/api/revalidate/${useCacheTagPrefix}/${url}` })

              const call2 = await invokeFunctionLambda1({ url })
              expect(call2).toHaveExpectedCachingBehavior(call1, {
                // invalidation done by lambda2 should invalidate lambda1 as well
                getDataTimeShouldBeEqual: false,
                resultWrapperComponentTimeShouldBeEqual: false,
                pageComponentTimeShouldBeEqual: false,
              })
            })
          })

          describe('TTL=5 seconds', () => {
            const routeRoot = `default/${useCacheLocationPathSegment}/dynamic/ttl-5seconds`

            test<FixtureTestContext>('regenerate after 5 seconds', async () => {
              const url = `${routeRoot}/same-lambda`

              const { invokeFunction } = await loadSandboxedFunction(ctx)

              const call1 = await invokeFunction({ url })
              expect(call1).not.toBeCacheableResponse()

              const call2 = await invokeFunction({ url })
              // making sure that setup is correct first and that caching is enabled
              expect(call2).toHaveExpectedCachingBehavior(
                call1,
                expectedCachingBehaviorWhenUseCacheRegenerates,
              )

              // wait for cache to expire
              await new Promise((resolve) => setTimeout(resolve, 5000))

              const call3 = await invokeFunction({ url })
              expect(call3).toHaveExpectedCachingBehavior(call2, {
                // cache should expire and fresh content should be generated
                getDataTimeShouldBeEqual: false,
                resultWrapperComponentTimeShouldBeEqual: false,
                pageComponentTimeShouldBeEqual: false,
              })
            })
          })
        })

        describe('static page (using response cache)', () => {
          for (const { isPrerendered, isPrerenderedTestLabel, isPrerenderedPathSegment } of [
            {
              isPrerendered: true,
              isPrerenderedTestLabel: 'prerendered',
              isPrerenderedPathSegment: 'prerendered',
            },
            {
              isPrerendered: false,
              isPrerenderedTestLabel: 'not prerendered',
              isPrerenderedPathSegment: 'not-prerendered',
            },
          ]) {
            describe(isPrerenderedTestLabel, () => {
              describe('page TTL=1 year, use cache TTL=1 year', () => {
                const routeRoot = `default/${useCacheLocationPathSegment}/static/ttl-1year`

                test<FixtureTestContext>('response cache continue to work and skips use cache handling', async () => {
                  const url = `${routeRoot}/${isPrerenderedPathSegment}`

                  const { invokeFunction } = await loadSandboxedFunction(ctx)

                  if (isPrerendered) {
                    const callPrerenderedStale = await invokeFunction({ url })
                    expect(callPrerenderedStale.headers['cache-status']).toBe(
                      '"Next.js"; hit; fwd=stale',
                    )
                  }

                  const call1 = await invokeFunction({ url })
                  expect(call1).toBeCacheableResponse()
                  expect(call1).toHaveResponseCacheTag(`${useCacheTagPrefix}/${url}`)

                  const call2 = await invokeFunction({ url })

                  expect(call2).toHaveExpectedCachingBehavior(call1, {
                    // response is served from response cache and `use cache` is not even actually used
                    getDataTimeShouldBeEqual: true,
                    resultWrapperComponentTimeShouldBeEqual: true,
                    pageComponentTimeShouldBeEqual: true,
                  })

                  // test response invalidation
                  await invokeFunction({
                    url: `/api/revalidate/${useCacheTagPrefix}/${url}`,
                  })

                  const call3 = await invokeFunction({ url })

                  expect(call3).toHaveExpectedCachingBehavior(call2, {
                    // invalidation shot result in everything changing
                    getDataTimeShouldBeEqual: false,
                    resultWrapperComponentTimeShouldBeEqual: false,
                    pageComponentTimeShouldBeEqual: false,
                  })
                })
              })

              describe('page TTL=5 seconds / use cache TTL=10 seconds', () => {
                const routeRoot = `default/${useCacheLocationPathSegment}/static/ttl-10seconds`

                test<FixtureTestContext>('both response cache and use cache respect their TTLs', async () => {
                  const url = `${routeRoot}/${isPrerenderedPathSegment}`

                  const { invokeFunction } = await loadSandboxedFunction(ctx)

                  if (isPrerendered) {
                    const callPrerenderedStale = await invokeFunction({ url })
                    expect(callPrerenderedStale.headers['cache-status']).toBe(
                      '"Next.js"; hit; fwd=stale',
                    )
                  }

                  const call1 = await invokeFunction({ url })
                  expect(call1).toBeCacheableResponse()
                  expect(call1).toHaveResponseCacheTag(`${useCacheTagPrefix}/${url}`)

                  const call2 = await invokeFunction({ url })

                  expect(call2).toHaveExpectedCachingBehavior(call1, {
                    // response is served from response cache and `use cache` is not even actually used
                    getDataTimeShouldBeEqual: true,
                    resultWrapperComponentTimeShouldBeEqual: true,
                    pageComponentTimeShouldBeEqual: true,
                  })

                  // wait for use cache to expire
                  await new Promise((resolve) => setTimeout(resolve, 5000))

                  const call3 = await invokeFunction({ url })
                  expect(call3).toHaveExpectedCachingBehavior(call2, {
                    // still stale content on first request after invalidation
                    getDataTimeShouldBeEqual: true,
                    resultWrapperComponentTimeShouldBeEqual: true,
                    pageComponentTimeShouldBeEqual: true,
                  })

                  const call4 = await invokeFunction({ url })
                  // fresh response, but use cache should still use cached data
                  expect(call4).toHaveExpectedCachingBehavior(
                    call3,
                    expectedCachingBehaviorWhenUseCacheRegenerates,
                  )
                })
              })
            })
          }
        })
      })
    }
  })
})
