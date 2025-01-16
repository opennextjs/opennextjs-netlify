import { expect } from '@playwright/test'
import { test } from '../utils/playwright-helpers.js'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'

export function waitFor(millis: number) {
  return new Promise((resolve) => setTimeout(resolve, millis))
}

/**
 * Check for content in 1 second intervals timing out after 30 seconds.
 *
 * @param {() => Promise<unknown> | unknown} contentFn
 * @param {RegExp | string | number} regex
 * @param {boolean} hardError
 * @param {number} maxRetries
 * @returns {Promise<boolean>}
 */
export async function check(
  contentFn: () => any | Promise<any>,
  regex: any,
  hardError = true,
  maxRetries = 30,
) {
  let content
  let lastErr

  for (let tries = 0; tries < maxRetries; tries++) {
    try {
      content = await contentFn()
      if (typeof regex !== typeof /regex/) {
        if (regex === content) {
          return true
        }
      } else if (regex.test(content)) {
        // found the content
        return true
      }
      await waitFor(1000)
    } catch (err) {
      await waitFor(1000)
      lastErr = err
    }
  }
  console.error('TIMED OUT CHECK: ', { regex, content, lastErr })

  if (hardError) {
    throw new Error('TIMED OUT: ' + regex + '\n\n' + content + '\n\n' + lastErr)
  }
  return false
}

test.describe('Simple Page Router (no basePath, no i18n)', () => {
  test.describe('On-demand revalidate works correctly', () => {
    for (const {
      label,
      useFallback,
      prerendered,
      pagePath,
      revalidateApiBasePath,
      expectedH1Content,
    } of [
      {
        label:
          'prerendered page with static path with fallback: blocking and awaited res.revalidate()',
        prerendered: true,
        pagePath: '/static/revalidate-manual',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Show #71',
      },
      {
        label:
          'prerendered page with dynamic path with fallback: blocking and awaited res.revalidate()',
        prerendered: true,
        pagePath: '/products/prerendered',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product prerendered',
      },
      {
        label:
          'not prerendered page with dynamic path with fallback: blocking and awaited res.revalidate()',
        prerendered: false,
        pagePath: '/products/not-prerendered',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product not-prerendered',
      },
      {
        label:
          'not prerendered page with dynamic path with fallback: blocking and not awaited res.revalidate()',
        prerendered: false,
        pagePath: '/products/not-prerendered-and-not-awaited-revalidation',
        revalidateApiBasePath: '/api/revalidate-no-await',
        expectedH1Content: 'Product not-prerendered-and-not-awaited-revalidation',
      },
      {
        label:
          'prerendered page with dynamic path with fallback: blocking and awaited res.revalidate() - non-ASCII variant',
        prerendered: true,
        pagePath: '/products/事前レンダリング,test',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product 事前レンダリング,test',
      },
      {
        label:
          'not prerendered page with dynamic path with fallback: blocking and awaited res.revalidate() - non-ASCII variant',
        prerendered: false,
        pagePath: '/products/事前レンダリングされていない,test',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product 事前レンダリングされていない,test',
      },
      {
        label:
          'prerendered page with dynamic path with fallback: true and awaited res.revalidate()',
        prerendered: true,
        pagePath: '/fallback-true/prerendered',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product prerendered',
      },
      {
        label:
          'not prerendered page with dynamic path with fallback: true and awaited res.revalidate()',
        prerendered: false,
        useFallback: true,
        pagePath: '/fallback-true/not-prerendered',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product not-prerendered',
      },
    ]) {
      test(label, async ({ page, pollUntilHeadersMatch, pageRouter }) => {
        // in case there is retry or some other test did hit that path before
        // we want to make sure that cdn cache is not warmed up
        const purgeCdnCache = await page.goto(
          new URL(`/api/purge-cdn?path=${encodeURI(pagePath)}`, pageRouter.url).href,
        )
        expect(purgeCdnCache?.status()).toBe(200)

        // wait a bit until cdn cache purge propagates
        await page.waitForTimeout(500)

        const response1 = await pollUntilHeadersMatch(new URL(pagePath, pageRouter.url).href, {
          headersToMatch: {
            // either first time hitting this route or we invalidated
            // just CDN node in earlier step
            // we will invoke function and see Next cache hit status
            // in the response because it was prerendered at build time
            // or regenerated in previous attempt to run this test
            'cache-status': [
              /"Netlify Edge"; fwd=(miss|stale)/m,
              prerendered ? /"Next.js"; hit/m : /"Next.js"; (hit|fwd=miss)/m,
            ],
          },
          headersNotMatchedMessage:
            'First request to tested page (html) should be a miss or stale on the Edge and hit in Next.js',
        })
        const headers1 = response1?.headers() || {}
        expect(response1?.status()).toBe(200)
        expect(headers1['x-nextjs-cache']).toBeUndefined()

        const fallbackWasServed =
          useFallback && headers1['cache-status'].includes('"Next.js"; fwd=miss')
        expect(headers1['netlify-cache-tag']).toBe(
          fallbackWasServed ? undefined : `_n_t_${encodeURI(pagePath).toLowerCase()}`,
        )
        expect(headers1['netlify-cdn-cache-control']).toBe(
          fallbackWasServed
            ? undefined
            : nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
        )

        if (fallbackWasServed) {
          const loading = await page.textContent('[data-testid="loading"]')
          expect(loading, 'Fallback should be shown').toBe('Loading...')
        }

        const date1 = await page.textContent('[data-testid="date-now"]')
        const h1 = await page.textContent('h1')
        expect(h1).toBe(expectedH1Content)

        // check json route
        const response1Json = await pollUntilHeadersMatch(
          new URL(`_next/data/build-id${pagePath}.json`, pageRouter.url).href,
          {
            headersToMatch: {
              // either first time hitting this route or we invalidated
              // just CDN node in earlier step
              // we will invoke function and see Next cache hit status \
              // in the response because it was prerendered at build time
              // or regenerated in previous attempt to run this test
              'cache-status': [/"Netlify Edge"; fwd=(miss|stale)/m, /"Next.js"; hit/m],
            },
            headersNotMatchedMessage:
              'First request to tested page (data) should be a miss or stale on the Edge and hit in Next.js',
          },
        )
        const headers1Json = response1Json?.headers() || {}
        expect(response1Json?.status()).toBe(200)
        expect(headers1Json['x-nextjs-cache']).toBeUndefined()
        expect(headers1Json['netlify-cache-tag']).toBe(`_n_t_${encodeURI(pagePath).toLowerCase()}`)
        expect(headers1Json['netlify-cdn-cache-control']).toBe(
          nextVersionSatisfies('>=15.0.0-canary.187')
            ? 's-maxage=31536000, durable'
            : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
        )
        const data1 = (await response1Json?.json()) || {}
        expect(data1?.pageProps?.time).toBe(date1)

        const response2 = await pollUntilHeadersMatch(new URL(pagePath, pageRouter.url).href, {
          headersToMatch: {
            // we are hitting the same page again and we most likely will see
            // CDN hit (in this case Next reported cache status is omitted
            // as it didn't actually take place in handling this request)
            // or we will see CDN miss because different CDN node handled request
            'cache-status': /"Netlify Edge"; (hit|fwd=miss|fwd=stale)/m,
          },
          headersNotMatchedMessage:
            'Second request to tested page (html) should most likely be a hit on the Edge (optionally miss or stale if different CDN node)',
        })
        const headers2 = response2?.headers() || {}
        expect(response2?.status()).toBe(200)
        expect(headers2['x-nextjs-cache']).toBeUndefined()
        if (!headers2['cache-status'].includes('"Netlify Edge"; hit')) {
          // if we missed CDN cache, we will see Next cache hit status
          // as we reuse cached response
          expect(headers2['cache-status']).toMatch(/"Next.js"; hit/m)
        }
        expect(headers2['netlify-cdn-cache-control']).toBe(
          nextVersionSatisfies('>=15.0.0-canary.187')
            ? 's-maxage=31536000, durable'
            : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
        )

        // the page is cached
        const date2 = await page.textContent('[data-testid="date-now"]')
        expect(date2).toBe(date1)

        // check json route
        const response2Json = await pollUntilHeadersMatch(
          new URL(`/_next/data/build-id${pagePath}.json`, pageRouter.url).href,
          {
            headersToMatch: {
              // we are hitting the same page again and we most likely will see
              // CDN hit (in this case Next reported cache status is omitted
              // as it didn't actually take place in handling this request)
              // or we will see CDN miss because different CDN node handled request
              'cache-status': /"Netlify Edge"; (hit|fwd=miss|fwd=stale)/m,
            },
            headersNotMatchedMessage:
              'Second request to tested page (data) should most likely be a hit on the Edge (optionally miss or stale if different CDN node)',
          },
        )
        const headers2Json = response2Json?.headers() || {}
        expect(response2Json?.status()).toBe(200)
        expect(headers2Json['x-nextjs-cache']).toBeUndefined()
        if (!headers2Json['cache-status'].includes('"Netlify Edge"; hit')) {
          // if we missed CDN cache, we will see Next cache hit status
          // as we reuse cached response
          expect(headers2Json['cache-status']).toMatch(/"Next.js"; hit/m)
        }
        expect(headers2Json['netlify-cdn-cache-control']).toBe(
          nextVersionSatisfies('>=15.0.0-canary.187')
            ? 's-maxage=31536000, durable'
            : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
        )

        const data2 = (await response2Json?.json()) || {}
        expect(data2?.pageProps?.time).toBe(date1)

        const revalidate = await page.goto(
          new URL(`${revalidateApiBasePath}?path=${pagePath}`, pageRouter.url).href,
        )
        expect(revalidate?.status()).toBe(200)

        // wait a bit until the page got regenerated
        await page.waitForTimeout(1000)

        // now after the revalidation it should have a different date
        const response3 = await pollUntilHeadersMatch(new URL(pagePath, pageRouter.url).href, {
          headersToMatch: {
            // revalidate refreshes Next cache, but not CDN cache
            // so our request after revalidation means that Next cache is already
            // warmed up with fresh response, but CDN cache just knows that previously
            // cached response is stale, so we are hitting our function that serve
            // already cached response
            'cache-status': [/"Next.js"; hit/m, /"Netlify Edge"; fwd=(miss|stale)/m],
          },
          headersNotMatchedMessage:
            'Third request to tested page (html) should be a miss or stale on the Edge and hit in Next.js after on-demand revalidation',
        })
        const headers3 = response3?.headers() || {}
        expect(response3?.status()).toBe(200)
        expect(headers3?.['x-nextjs-cache']).toBeUndefined()

        // the page has now an updated date
        const date3 = await page.textContent('[data-testid="date-now"]')
        expect(date3).not.toBe(date2)

        // check json route
        const response3Json = await pollUntilHeadersMatch(
          new URL(`/_next/data/build-id${pagePath}.json`, pageRouter.url).href,
          {
            headersToMatch: {
              // revalidate refreshes Next cache, but not CDN cache
              // so our request after revalidation means that Next cache is already
              // warmed up with fresh response, but CDN cache just knows that previously
              // cached response is stale, so we are hitting our function that serve
              // already cached response
              'cache-status': [/"Next.js"; hit/m, /"Netlify Edge"; fwd=(miss|stale)/m],
            },
            headersNotMatchedMessage:
              'Third request to tested page (data) should be a miss or stale on the Edge and hit in Next.js after on-demand revalidation',
          },
        )
        const headers3Json = response3Json?.headers() || {}
        expect(response3Json?.status()).toBe(200)
        expect(headers3Json['x-nextjs-cache']).toBeUndefined()
        expect(headers3Json['netlify-cdn-cache-control']).toBe(
          nextVersionSatisfies('>=15.0.0-canary.187')
            ? 's-maxage=31536000, durable'
            : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
        )

        const data3 = (await response3Json?.json()) || {}
        expect(data3?.pageProps?.time).toBe(date3)
      })
    }
  })

  test('Time based revalidate works correctly', async ({
    page,
    pollUntilHeadersMatch,
    pageRouter,
  }) => {
    // in case there is retry or some other test did hit that path before
    // we want to make sure that cdn cache is not warmed up
    const purgeCdnCache = await page.goto(
      new URL('/api/purge-cdn?path=/static/revalidate-slow-data', pageRouter.url).href,
    )
    expect(purgeCdnCache?.status()).toBe(200)

    // wait a bit until cdn cache purge propagates and make sure page gets stale (revalidate 10)
    await page.waitForTimeout(10_000)

    const beforeFetch = new Date().toISOString()

    const response1 = await pollUntilHeadersMatch(
      new URL('static/revalidate-slow-data', pageRouter.url).href,
      {
        headersToMatch: {
          // either first time hitting this route or we invalidated
          // just CDN node in earlier step
          // we will invoke function and see Next cache hit status \
          // in the response because it was prerendered at build time
          // or regenerated in previous attempt to run this test
          'cache-status': [/"Netlify Edge"; fwd=(miss|stale)/m, /"Next.js"; hit/m],
        },
        headersNotMatchedMessage:
          'First request to tested page (html) should be a miss or stale on the Edge and stale in Next.js',
      },
    )
    expect(response1?.status()).toBe(200)
    const date1 = (await page.textContent('[data-testid="date-now"]')) ?? ''

    // ensure response was produced before invocation (served from cache)
    expect(date1.localeCompare(beforeFetch)).toBeLessThan(0)

    // wait a bit to ensure background work has a chance to finish
    // (page is fresh for 10 seconds and it should take at least 5 seconds to regenerate, so we should wait at least more than 15 seconds)
    await page.waitForTimeout(20_000)

    const response2 = await pollUntilHeadersMatch(
      new URL('static/revalidate-slow-data', pageRouter.url).href,
      {
        headersToMatch: {
          // either first time hitting this route or we invalidated
          // just CDN node in earlier step
          // we will invoke function and see Next cache hit status \
          // in the response because it was prerendered at build time
          // or regenerated in previous attempt to run this test
          'cache-status': [/"Netlify Edge"; fwd=(miss|stale)/m, /"Next.js"; hit;/m],
        },
        headersNotMatchedMessage:
          'Second request to tested page (html) should be a miss or stale on the Edge and hit or stale in Next.js',
      },
    )
    expect(response2?.status()).toBe(200)
    const date2 = (await page.textContent('[data-testid="date-now"]')) ?? ''

    // ensure response was produced after initial invocation
    expect(beforeFetch.localeCompare(date2)).toBeLessThan(0)
  })

  test('should serve 404 page when requesting non existing page (no matching route)', async ({
    page,
    pageRouter,
  }) => {
    // 404 page is built and uploaded to blobs at build time
    // when Next.js serves 404 it will try to fetch it from the blob store
    // if request handler function is unable to get from blob store it will
    // fail request handling and serve 500 error.
    // This implicitly tests that request handler function is able to read blobs
    // that are uploaded as part of site deploy.

    const response = await page.goto(new URL('non-existing', pageRouter.url).href)
    const headers = response?.headers() || {}
    expect(response?.status()).toBe(404)

    expect(await page.textContent('h1')).toBe('404')

    // https://github.com/vercel/next.js/pull/69802 made changes to returned cache-control header,
    // after that (14.2.10 and canary.147) 404 pages would have `private` directive, before that
    // it would not
    const shouldHavePrivateDirective = nextVersionSatisfies('^14.2.10 || >=15.0.0-canary.147')
    expect(headers['netlify-cdn-cache-control']).toBe(
      (shouldHavePrivateDirective ? 'private, ' : '') +
        'no-cache, no-store, max-age=0, must-revalidate, durable',
    )
    expect(headers['cache-control']).toBe(
      (shouldHavePrivateDirective ? 'private,' : '') +
        'no-cache,no-store,max-age=0,must-revalidate',
    )
  })

  test('should serve 404 page when requesting non existing page (marked with notFound: true in getStaticProps)', async ({
    page,
    pageRouter,
  }) => {
    const response = await page.goto(new URL('static/not-found', pageRouter.url).href)
    const headers = response?.headers() || {}
    expect(response?.status()).toBe(404)

    expect(await page.textContent('h1')).toBe('404')

    expect(headers['netlify-cdn-cache-control']).toBe(
      nextVersionSatisfies('>=15.0.0-canary.187')
        ? 's-maxage=31536000, durable'
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    )
    expect(headers['cache-control']).toBe('public,max-age=0,must-revalidate')
  })

  test('requesting a page with a very long name works', async ({ page, pageRouter }) => {
    const response = await page.goto(
      new URL(
        '/products/an-incredibly-long-product-name-thats-impressively-repetetively-needlessly-overdimensioned-and-should-be-shortened-to-less-than-255-characters-for-the-sake-of-seo-and-ux-and-first-and-foremost-for-gods-sake-but-nobody-wont-ever-read-this-anyway',
        pageRouter.url,
      ).href,
    )
    expect(response?.status()).toBe(200)
  })

  // adapted from https://github.com/vercel/next.js/blob/89fcf68c6acd62caf91a8cf0bfd3fdc566e75d9d/test/e2e/app-dir/app-static/app-static.test.ts#L108

  test('unstable-cache should work', async ({ pageRouter }) => {
    const pathname = `${pageRouter.url}/api/unstable-cache-node`
    let res = await fetch(`${pageRouter.url}/api/unstable-cache-node`)
    expect(res.status).toBe(200)
    let prevData = await res.json()

    expect(prevData.data.random).toBeTruthy()

    await check(async () => {
      res = await fetch(pathname)
      expect(res.status).toBe(200)
      const curData = await res.json()

      try {
        expect(curData.data.random).toBeTruthy()
        expect(curData.data.random).toBe(prevData.data.random)
      } finally {
        prevData = curData
      }
      return 'success'
    }, 'success')
  })

  test('Fully static pages should be cached permanently', async ({ page, pageRouter }) => {
    const response = await page.goto(new URL('static/fully-static', pageRouter.url).href)
    const headers = response?.headers() || {}

    expect(headers['netlify-cdn-cache-control']).toBe('max-age=31536000, durable')
    expect(headers['cache-control']).toBe('public,max-age=0,must-revalidate')
  })

  test('environment variables from .env files should be available for functions', async ({
    pageRouter,
  }) => {
    const response = await fetch(`${pageRouter.url}/api/env`)
    const data = await response.json()
    expect(data).toEqual({
      '.env': 'defined in .env',
      '.env.local': 'defined in .env.local',
      '.env.production': 'defined in .env.production',
      '.env.production.local': 'defined in .env.production.local',
    })
  })

  test('ISR pages that are the same after regeneration execute background getStaticProps uninterrupted', async ({
    page,
    pageRouter,
  }) => {
    const slug = Date.now()

    await page.goto(new URL(`always-the-same-body/${slug}`, pageRouter.url).href)

    await new Promise((resolve) => setTimeout(resolve, 15_000))

    await page.goto(new URL(`always-the-same-body/${slug}`, pageRouter.url).href)

    await new Promise((resolve) => setTimeout(resolve, 15_000))

    await page.goto(new URL(`always-the-same-body/${slug}`, pageRouter.url).href)

    await new Promise((resolve) => setTimeout(resolve, 15_000))

    // keep lambda executing to allow for background getStaticProps to finish in case background work execution was suspended
    await fetch(new URL(`api/sleep-5`, pageRouter.url).href)

    const response = await fetch(new URL(`read-static-props-blobs/${slug}`, pageRouter.url).href)
    expect(response.ok, 'response for stored data status should not fail').toBe(true)

    const data = await response.json()

    expect(typeof data.start, 'timestamp of getStaticProps start should be a number').toEqual(
      'number',
    )
    expect(typeof data.end, 'timestamp of getStaticProps end should be a number').toEqual('number')

    // duration should be around 5s overall, due to 5s timeout, but this is not exact so let's be generous and allow 10 seconds
    // which is still less than 15 seconds between requests
    expect(
      data.end - data.start,
      'getStaticProps duration should not be longer than 10 seconds',
    ).toBeLessThan(10_000)
  })
})

test.describe('Page Router with basePath and i18n', () => {
  test.describe('Static revalidate works correctly', () => {
    for (const {
      label,
      useFallback,
      prerendered,
      pagePath,
      revalidateApiBasePath,
      expectedH1Content,
    } of [
      {
        label: 'prerendered page with static path and awaited res.revalidate()',
        prerendered: true,
        pagePath: '/static/revalidate-manual',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Show #71',
      },
      {
        label:
          'prerendered page with dynamic path with fallback: blocking and awaited res.revalidate()',
        prerendered: true,
        pagePath: '/products/prerendered',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product prerendered',
      },
      {
        label:
          'not prerendered page with dynamic path with fallback: blocking and awaited res.revalidate()',
        prerendered: false,
        pagePath: '/products/not-prerendered',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product not-prerendered',
      },
      {
        label:
          'not prerendered page with dynamic path with fallback: blocking and not awaited res.revalidate()',
        prerendered: false,
        pagePath: '/products/not-prerendered-and-not-awaited-revalidation',
        revalidateApiBasePath: '/api/revalidate-no-await',
        expectedH1Content: 'Product not-prerendered-and-not-awaited-revalidation',
      },
      {
        label:
          'prerendered page with dynamic path with fallback: blocking and awaited res.revalidate() - non-ASCII variant',
        prerendered: true,
        pagePath: '/products/事前レンダリング,test',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product 事前レンダリング,test',
      },
      {
        label:
          'not prerendered page with dynamic path with fallback: blocking and awaited res.revalidate() - non-ASCII variant',
        prerendered: false,
        pagePath: '/products/事前レンダリングされていない,test',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product 事前レンダリングされていない,test',
      },
      {
        label:
          'prerendered page with dynamic path with fallback: true and awaited res.revalidate()',
        prerendered: true,
        pagePath: '/fallback-true/prerendered',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product prerendered',
      },
      {
        label:
          'not prerendered page with dynamic path with fallback: true and awaited res.revalidate()',
        prerendered: false,
        useFallback: true,
        pagePath: '/fallback-true/not-prerendered',
        revalidateApiBasePath: '/api/revalidate',
        expectedH1Content: 'Product not-prerendered',
      },
    ]) {
      test.describe(label, () => {
        test(`default locale`, async ({ page, pollUntilHeadersMatch, pageRouterBasePathI18n }) => {
          // in case there is retry or some other test did hit that path before
          // we want to make sure that cdn cache is not warmed up
          const purgeCdnCache = await page.goto(
            new URL(
              `/base/path/api/purge-cdn?path=/en${encodeURI(pagePath)}`,
              pageRouterBasePathI18n.url,
            ).href,
          )
          expect(purgeCdnCache?.status()).toBe(200)

          // wait a bit until cdn cache purge propagates
          await page.waitForTimeout(500)

          const response1ImplicitLocale = await pollUntilHeadersMatch(
            new URL(`base/path${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // either first time hitting this route or we invalidated
                // just CDN node in earlier step
                // we will invoke function and see Next cache hit status
                // in the response because it was prerendered at build time
                // or regenerated in previous attempt to run this test
                'cache-status': [
                  /"Netlify Edge"; fwd=(miss|stale)/m,
                  prerendered ? /"Next.js"; hit/m : /"Next.js"; (hit|fwd=miss)/m,
                ],
              },
              headersNotMatchedMessage:
                'First request to tested page (implicit locale html) should be a miss or stale on the Edge and hit in Next.js',
            },
          )
          const headers1ImplicitLocale = response1ImplicitLocale?.headers() || {}
          expect(response1ImplicitLocale?.status()).toBe(200)
          expect(headers1ImplicitLocale['x-nextjs-cache']).toBeUndefined()

          const fallbackWasServedImplicitLocale =
            useFallback && headers1ImplicitLocale['cache-status'].includes('"Next.js"; fwd=miss')

          expect(headers1ImplicitLocale['netlify-cache-tag']).toBe(
            fallbackWasServedImplicitLocale
              ? undefined
              : `_n_t_/en${encodeURI(pagePath).toLowerCase()}`,
          )
          expect(headers1ImplicitLocale['netlify-cdn-cache-control']).toBe(
            fallbackWasServedImplicitLocale
              ? undefined
              : nextVersionSatisfies('>=15.0.0-canary.187')
                ? 's-maxage=31536000, durable'
                : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          if (fallbackWasServedImplicitLocale) {
            const loading = await page.textContent('[data-testid="loading"]')
            expect(loading, 'Fallback should be shown').toBe('Loading...')
          }

          const date1ImplicitLocale = await page.textContent('[data-testid="date-now"]')
          const h1ImplicitLocale = await page.textContent('h1')
          expect(h1ImplicitLocale).toBe(expectedH1Content)

          const response1ExplicitLocale = await pollUntilHeadersMatch(
            new URL(`base/path/en${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // either first time hitting this route or we invalidated
                // just CDN node in earlier step
                // we will invoke function and see Next cache hit status \
                // in the response because it was set by previous request that didn't have locale in pathname
                'cache-status': [/"Netlify Edge"; fwd=(miss|stale)/m, /"Next.js"; hit/m],
              },
              headersNotMatchedMessage:
                'First request to tested page (explicit locale html) should be a miss or stale on the Edge and hit in Next.js',
            },
          )
          const headers1ExplicitLocale = response1ExplicitLocale?.headers() || {}
          expect(response1ExplicitLocale?.status()).toBe(200)
          expect(headers1ExplicitLocale['x-nextjs-cache']).toBeUndefined()

          const fallbackWasServedExplicitLocale =
            useFallback && headers1ExplicitLocale['cache-status'].includes('"Next.js"; fwd=miss')
          expect(headers1ExplicitLocale['netlify-cache-tag']).toBe(
            fallbackWasServedExplicitLocale
              ? undefined
              : `_n_t_/en${encodeURI(pagePath).toLowerCase()}`,
          )
          expect(headers1ExplicitLocale['netlify-cdn-cache-control']).toBe(
            fallbackWasServedExplicitLocale
              ? undefined
              : nextVersionSatisfies('>=15.0.0-canary.187')
                ? 's-maxage=31536000, durable'
                : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          if (fallbackWasServedExplicitLocale) {
            const loading = await page.textContent('[data-testid="loading"]')
            expect(loading, 'Fallback should be shown').toBe('Loading...')
          }

          const date1ExplicitLocale = await page.textContent('[data-testid="date-now"]')
          const h1ExplicitLocale = await page.textContent('h1')
          expect(h1ExplicitLocale).toBe(expectedH1Content)

          // implicit and explicit locale paths should be the same (same cached response)
          expect(date1ImplicitLocale).toBe(date1ExplicitLocale)

          // check json route
          const response1Json = await pollUntilHeadersMatch(
            new URL(`base/path/_next/data/build-id/en${pagePath}.json`, pageRouterBasePathI18n.url)
              .href,
            {
              headersToMatch: {
                // either first time hitting this route or we invalidated
                // just CDN node in earlier step
                // we will invoke function and see Next cache hit status \
                // in the response because it was prerendered at build time
                // or regenerated in previous attempt to run this test
                'cache-status': [/"Netlify Edge"; fwd=(miss|stale)/m, /"Next.js"; hit/m],
              },
              headersNotMatchedMessage:
                'First request to tested page (data) should be a miss or stale on the Edge and hit in Next.js',
            },
          )
          const headers1Json = response1Json?.headers() || {}
          expect(response1Json?.status()).toBe(200)
          expect(headers1Json['x-nextjs-cache']).toBeUndefined()
          expect(headers1Json['netlify-cache-tag']).toBe(
            `_n_t_/en${encodeURI(pagePath).toLowerCase()}`,
          )
          expect(headers1Json['netlify-cdn-cache-control']).toBe(
            nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )
          const data1 = (await response1Json?.json()) || {}
          expect(data1?.pageProps?.time).toBe(date1ImplicitLocale)

          const response2ImplicitLocale = await pollUntilHeadersMatch(
            new URL(`base/path${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // we are hitting the same page again and we most likely will see
                // CDN hit (in this case Next reported cache status is omitted
                // as it didn't actually take place in handling this request)
                // or we will see CDN miss because different CDN node handled request
                'cache-status': /"Netlify Edge"; (hit|fwd=miss|fwd=stale)/m,
              },
              headersNotMatchedMessage:
                'Second request to tested page (implicit locale html) should most likely be a hit on the Edge (optionally miss or stale if different CDN node)',
            },
          )
          const headers2ImplicitLocale = response2ImplicitLocale?.headers() || {}
          expect(response2ImplicitLocale?.status()).toBe(200)
          expect(headers2ImplicitLocale['x-nextjs-cache']).toBeUndefined()
          if (!headers2ImplicitLocale['cache-status'].includes('"Netlify Edge"; hit')) {
            // if we missed CDN cache, we will see Next cache hit status
            // as we reuse cached response
            expect(headers2ImplicitLocale['cache-status']).toMatch(/"Next.js"; hit/m)
          }
          expect(headers2ImplicitLocale['netlify-cdn-cache-control']).toBe(
            nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          // the page is cached
          const date2ImplicitLocale = await page.textContent('[data-testid="date-now"]')
          expect(date2ImplicitLocale).toBe(date1ImplicitLocale)

          const response2ExplicitLocale = await pollUntilHeadersMatch(
            new URL(`base/path${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // we are hitting the same page again and we most likely will see
                // CDN hit (in this case Next reported cache status is omitted
                // as it didn't actually take place in handling this request)
                // or we will see CDN miss because different CDN node handled request
                'cache-status': /"Netlify Edge"; (hit|fwd=miss|fwd=stale)/m,
              },
              headersNotMatchedMessage:
                'Second request to tested page (implicit locale html) should most likely be a hit on the Edge (optionally miss or stale if different CDN node)',
            },
          )
          const headers2ExplicitLocale = response2ExplicitLocale?.headers() || {}
          expect(response2ExplicitLocale?.status()).toBe(200)
          expect(headers2ExplicitLocale['x-nextjs-cache']).toBeUndefined()
          if (!headers2ExplicitLocale['cache-status'].includes('"Netlify Edge"; hit')) {
            // if we missed CDN cache, we will see Next cache hit status
            // as we reuse cached response
            expect(headers2ExplicitLocale['cache-status']).toMatch(/"Next.js"; hit/m)
          }
          expect(headers2ExplicitLocale['netlify-cdn-cache-control']).toBe(
            nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          // the page is cached
          const date2ExplicitLocale = await page.textContent('[data-testid="date-now"]')
          expect(date2ExplicitLocale).toBe(date1ExplicitLocale)

          // check json route
          const response2Json = await pollUntilHeadersMatch(
            new URL(`base/path/_next/data/build-id/en${pagePath}.json`, pageRouterBasePathI18n.url)
              .href,
            {
              headersToMatch: {
                // we are hitting the same page again and we most likely will see
                // CDN hit (in this case Next reported cache status is omitted
                // as it didn't actually take place in handling this request)
                // or we will see CDN miss because different CDN node handled request
                'cache-status': /"Netlify Edge"; (hit|fwd=miss|fwd=stale)/m,
              },
              headersNotMatchedMessage:
                'Second request to tested page (data) should most likely be a hit on the Edge (optionally miss or stale if different CDN node)',
            },
          )
          const headers2Json = response2Json?.headers() || {}
          expect(response2Json?.status()).toBe(200)
          if (!headers2Json['cache-status'].includes('"Netlify Edge"; hit')) {
            // if we missed CDN cache, we will see Next cache hit status
            // as we reuse cached response
            expect(headers2Json['cache-status']).toMatch(/"Next.js"; hit/m)
          }
          expect(headers2Json['netlify-cdn-cache-control']).toBe(
            nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          const data2 = (await response2Json?.json()) || {}
          expect(data2?.pageProps?.time).toBe(date1ImplicitLocale)

          // revalidate implicit locale path
          const revalidateImplicit = await page.goto(
            new URL(
              `/base/path${revalidateApiBasePath}?path=${pagePath}`,
              pageRouterBasePathI18n.url,
            ).href,
          )
          expect(revalidateImplicit?.status()).toBe(200)

          // wait a bit until the page got regenerated
          await page.waitForTimeout(1000)

          // now after the revalidation it should have a different date
          const response3ImplicitLocale = await pollUntilHeadersMatch(
            new URL(`base/path${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // revalidate refreshes Next cache, but not CDN cache
                // so our request after revalidation means that Next cache is already
                // warmed up with fresh response, but CDN cache just knows that previously
                // cached response is stale, so we are hitting our function that serve
                // already cached response
                'cache-status': [/"Next.js"; hit/m, /"Netlify Edge"; fwd=(miss|stale)/m],
              },
              headersNotMatchedMessage:
                'Third request to tested page (implicit locale html) should be a miss or stale on the Edge and hit in Next.js after on-demand revalidation',
            },
          )
          const headers3ImplicitLocale = response3ImplicitLocale?.headers() || {}
          expect(response3ImplicitLocale?.status()).toBe(200)
          expect(headers3ImplicitLocale?.['x-nextjs-cache']).toBeUndefined()

          // the page has now an updated date
          const date3ImplicitLocale = await page.textContent('[data-testid="date-now"]')
          expect(date3ImplicitLocale).not.toBe(date2ImplicitLocale)

          const response3ExplicitLocale = await pollUntilHeadersMatch(
            new URL(`base/path/en${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // revalidate refreshes Next cache, but not CDN cache
                // so our request after revalidation means that Next cache is already
                // warmed up with fresh response, but CDN cache just knows that previously
                // cached response is stale, so we are hitting our function that serve
                // already cached response
                'cache-status': [/"Next.js"; hit/m, /"Netlify Edge"; fwd=(miss|stale)/m],
              },
              headersNotMatchedMessage:
                'Third request to tested page (explicit locale html) should be a miss or stale on the Edge and hit in Next.js after on-demand revalidation',
            },
          )
          const headers3ExplicitLocale = response3ExplicitLocale?.headers() || {}
          expect(response3ExplicitLocale?.status()).toBe(200)
          expect(headers3ExplicitLocale?.['x-nextjs-cache']).toBeUndefined()

          // the page has now an updated date
          const date3ExplicitLocale = await page.textContent('[data-testid="date-now"]')
          expect(date3ExplicitLocale).not.toBe(date2ExplicitLocale)

          // implicit and explicit locale paths should be the same (same cached response)
          expect(date3ImplicitLocale).toBe(date3ExplicitLocale)

          // check json route
          const response3Json = await pollUntilHeadersMatch(
            new URL(`base/path/_next/data/build-id/en${pagePath}.json`, pageRouterBasePathI18n.url)
              .href,
            {
              headersToMatch: {
                // revalidate refreshes Next cache, but not CDN cache
                // so our request after revalidation means that Next cache is already
                // warmed up with fresh response, but CDN cache just knows that previously
                // cached response is stale, so we are hitting our function that serve
                // already cached response
                'cache-status': [/"Next.js"; hit/m, /"Netlify Edge"; fwd=(miss|stale)/m],
              },
              headersNotMatchedMessage:
                'Third request to tested page (data) should be a miss or stale on the Edge and hit in Next.js after on-demand revalidation',
            },
          )
          const headers3Json = response3Json?.headers() || {}
          expect(response3Json?.status()).toBe(200)
          expect(headers3Json['x-nextjs-cache']).toBeUndefined()
          if (!headers3Json['cache-status'].includes('"Netlify Edge"; hit')) {
            // if we missed CDN cache, we will see Next cache hit status
            // as we reuse cached response
            expect(headers3Json['cache-status']).toMatch(/"Next.js"; hit/m)
          }
          expect(headers3Json['netlify-cdn-cache-control']).toBe(
            nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          const data3 = (await response3Json?.json()) || {}
          expect(data3?.pageProps?.time).toBe(date3ImplicitLocale)

          // revalidate implicit locale path
          const revalidateExplicit = await page.goto(
            new URL(
              `/base/path${revalidateApiBasePath}?path=/en${pagePath}`,
              pageRouterBasePathI18n.url,
            ).href,
          )
          expect(revalidateExplicit?.status()).toBe(200)

          // wait a bit until the page got regenerated
          await page.waitForTimeout(1000)

          // now after the revalidation it should have a different date
          const response4ImplicitLocale = await pollUntilHeadersMatch(
            new URL(`base/path${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // revalidate refreshes Next cache, but not CDN cache
                // so our request after revalidation means that Next cache is already
                // warmed up with fresh response, but CDN cache just knows that previously
                // cached response is stale, so we are hitting our function that serve
                // already cached response
                'cache-status': [/"Next.js"; hit/m, /"Netlify Edge"; fwd=(miss|stale)/m],
              },
              headersNotMatchedMessage:
                'Fourth request to tested page (implicit locale html) should be a miss or stale on the Edge and hit in Next.js after on-demand revalidation',
            },
          )
          const headers4ImplicitLocale = response4ImplicitLocale?.headers() || {}
          expect(response4ImplicitLocale?.status()).toBe(200)
          expect(headers4ImplicitLocale?.['x-nextjs-cache']).toBeUndefined()

          // the page has now an updated date
          const date4ImplicitLocale = await page.textContent('[data-testid="date-now"]')
          expect(date4ImplicitLocale).not.toBe(date3ImplicitLocale)

          const response4ExplicitLocale = await pollUntilHeadersMatch(
            new URL(`base/path/en${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // revalidate refreshes Next cache, but not CDN cache
                // so our request after revalidation means that Next cache is already
                // warmed up with fresh response, but CDN cache just knows that previously
                // cached response is stale, so we are hitting our function that serve
                // already cached response
                'cache-status': [/"Next.js"; hit/m, /"Netlify Edge"; fwd=(miss|stale)/m],
              },
              headersNotMatchedMessage:
                'Fourth request to tested page (explicit locale html) should be a miss or stale on the Edge and hit in Next.js after on-demand revalidation',
            },
          )
          const headers4ExplicitLocale = response4ExplicitLocale?.headers() || {}
          expect(response4ExplicitLocale?.status()).toBe(200)
          expect(headers4ExplicitLocale?.['x-nextjs-cache']).toBeUndefined()

          // the page has now an updated date
          const date4ExplicitLocale = await page.textContent('[data-testid="date-now"]')
          expect(date4ExplicitLocale).not.toBe(date3ExplicitLocale)

          // implicit and explicit locale paths should be the same (same cached response)
          expect(date4ImplicitLocale).toBe(date4ExplicitLocale)

          // check json route
          const response4Json = await pollUntilHeadersMatch(
            new URL(`base/path/_next/data/build-id/en${pagePath}.json`, pageRouterBasePathI18n.url)
              .href,
            {
              headersToMatch: {
                // revalidate refreshes Next cache, but not CDN cache
                // so our request after revalidation means that Next cache is already
                // warmed up with fresh response, but CDN cache just knows that previously
                // cached response is stale, so we are hitting our function that serve
                // already cached response
                'cache-status': [/"Next.js"; hit/m, /"Netlify Edge"; fwd=(miss|stale)/m],
              },
              headersNotMatchedMessage:
                'Fourth request to tested page (data) should be a miss or stale on the Edge and hit in Next.js after on-demand revalidation',
            },
          )
          const headers4Json = response4Json?.headers() || {}
          expect(response4Json?.status()).toBe(200)
          expect(headers4Json['x-nextjs-cache']).toBeUndefined()
          expect(headers4Json['netlify-cdn-cache-control']).toBe(
            nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          const data4 = (await response4Json?.json()) || {}
          expect(data4?.pageProps?.time).toBe(date4ImplicitLocale)
        })

        test('non-default locale', async ({
          page,
          pollUntilHeadersMatch,
          pageRouterBasePathI18n,
        }) => {
          // in case there is retry or some other test did hit that path before
          // we want to make sure that cdn cache is not warmed up
          const purgeCdnCache = await page.goto(
            new URL(`/base/path/api/purge-cdn?path=/de${pagePath}`, pageRouterBasePathI18n.url)
              .href,
          )
          expect(purgeCdnCache?.status()).toBe(200)

          // wait a bit until cdn cache purge propagates
          await page.waitForTimeout(500)

          const response1 = await pollUntilHeadersMatch(
            new URL(`/base/path/de${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // either first time hitting this route or we invalidated
                // just CDN node in earlier step
                // we will invoke function and see Next cache hit status
                // in the response because it was prerendered at build time
                // or regenerated in previous attempt to run this test
                'cache-status': [
                  /"Netlify Edge"; fwd=(miss|stale)/m,
                  prerendered ? /"Next.js"; hit/m : /"Next.js"; (hit|fwd=miss)/m,
                ],
              },
              headersNotMatchedMessage:
                'First request to tested page (html) should be a miss or stale on the Edge and hit in Next.js',
            },
          )
          const headers1 = response1?.headers() || {}
          expect(response1?.status()).toBe(200)
          expect(headers1['x-nextjs-cache']).toBeUndefined()

          const fallbackWasServed =
            useFallback && headers1['cache-status'].includes('"Next.js"; fwd=miss')
          expect(headers1['netlify-cache-tag']).toBe(
            fallbackWasServed ? undefined : `_n_t_/de${encodeURI(pagePath).toLowerCase()}`,
          )
          expect(headers1['netlify-cdn-cache-control']).toBe(
            fallbackWasServed
              ? undefined
              : nextVersionSatisfies('>=15.0.0-canary.187')
                ? 's-maxage=31536000, durable'
                : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          if (fallbackWasServed) {
            const loading = await page.textContent('[data-testid="loading"]')
            expect(loading, 'Fallback should be shown').toBe('Loading...')
          }

          const date1 = await page.textContent('[data-testid="date-now"]')
          const h1 = await page.textContent('h1')
          expect(h1).toBe(expectedH1Content)

          // check json route
          const response1Json = await pollUntilHeadersMatch(
            new URL(`base/path/_next/data/build-id/de${pagePath}.json`, pageRouterBasePathI18n.url)
              .href,
            {
              headersToMatch: {
                // either first time hitting this route or we invalidated
                // just CDN node in earlier step
                // we will invoke function and see Next cache hit status \
                // in the response because it was prerendered at build time
                // or regenerated in previous attempt to run this test
                'cache-status': [/"Netlify Edge"; fwd=(miss|stale)/m, /"Next.js"; hit/m],
              },
              headersNotMatchedMessage:
                'First request to tested page (data) should be a miss or stale on the Edge and hit in Next.js',
            },
          )
          const headers1Json = response1Json?.headers() || {}
          expect(response1Json?.status()).toBe(200)
          expect(headers1Json['x-nextjs-cache']).toBeUndefined()
          expect(headers1Json['netlify-cache-tag']).toBe(
            `_n_t_/de${encodeURI(pagePath).toLowerCase()}`,
          )
          expect(headers1Json['netlify-cdn-cache-control']).toBe(
            nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )
          const data1 = (await response1Json?.json()) || {}
          expect(data1?.pageProps?.time).toBe(date1)

          const response2 = await pollUntilHeadersMatch(
            new URL(`base/path/de${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // we are hitting the same page again and we most likely will see
                // CDN hit (in this case Next reported cache status is omitted
                // as it didn't actually take place in handling this request)
                // or we will see CDN miss because different CDN node handled request
                'cache-status': /"Netlify Edge"; (hit|fwd=miss|fwd=stale)/m,
              },
              headersNotMatchedMessage:
                'Second request to tested page (html) should most likely be a hit on the Edge (optionally miss or stale if different CDN node)',
            },
          )
          const headers2 = response2?.headers() || {}
          expect(response2?.status()).toBe(200)
          expect(headers2['x-nextjs-cache']).toBeUndefined()
          if (!headers2['cache-status'].includes('"Netlify Edge"; hit')) {
            // if we missed CDN cache, we will see Next cache hit status
            // as we reuse cached response
            expect(headers2['cache-status']).toMatch(/"Next.js"; hit/m)
          }
          expect(headers2['netlify-cdn-cache-control']).toBe(
            nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          // the page is cached
          const date2 = await page.textContent('[data-testid="date-now"]')
          expect(date2).toBe(date1)

          // check json route
          const response2Json = await pollUntilHeadersMatch(
            new URL(`base/path/_next/data/build-id/de${pagePath}.json`, pageRouterBasePathI18n.url)
              .href,
            {
              headersToMatch: {
                // we are hitting the same page again and we most likely will see
                // CDN hit (in this case Next reported cache status is omitted
                // as it didn't actually take place in handling this request)
                // or we will see CDN miss because different CDN node handled request
                'cache-status': /"Netlify Edge"; (hit|fwd=miss|fwd=stale)/m,
              },
              headersNotMatchedMessage:
                'Second request to tested page (data) should most likely be a hit on the Edge (optionally miss or stale if different CDN node)',
            },
          )
          const headers2Json = response2Json?.headers() || {}
          expect(response2Json?.status()).toBe(200)
          expect(headers2Json['x-nextjs-cache']).toBeUndefined()
          if (!headers2Json['cache-status'].includes('"Netlify Edge"; hit')) {
            // if we missed CDN cache, we will see Next cache hit status
            // as we reuse cached response
            expect(headers2Json['cache-status']).toMatch(/"Next.js"; hit/m)
          }
          expect(headers2Json['netlify-cdn-cache-control']).toBe(
            nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          const data2 = (await response2Json?.json()) || {}
          expect(data2?.pageProps?.time).toBe(date1)

          const revalidate = await page.goto(
            new URL(
              `/base/path${revalidateApiBasePath}?path=/de${pagePath}`,
              pageRouterBasePathI18n.url,
            ).href,
          )
          expect(revalidate?.status()).toBe(200)

          // wait a bit until the page got regenerated
          await page.waitForTimeout(1000)

          // now after the revalidation it should have a different date
          const response3 = await pollUntilHeadersMatch(
            new URL(`base/path/de${pagePath}`, pageRouterBasePathI18n.url).href,
            {
              headersToMatch: {
                // revalidate refreshes Next cache, but not CDN cache
                // so our request after revalidation means that Next cache is already
                // warmed up with fresh response, but CDN cache just knows that previously
                // cached response is stale, so we are hitting our function that serve
                // already cached response
                'cache-status': [/"Next.js"; hit/m, /"Netlify Edge"; fwd=(miss|stale)/m],
              },
              headersNotMatchedMessage:
                'Third request to tested page (html) should be a miss or stale on the Edge and hit in Next.js after on-demand revalidation',
            },
          )
          const headers3 = response3?.headers() || {}
          expect(response3?.status()).toBe(200)
          expect(headers3?.['x-nextjs-cache']).toBeUndefined()

          // the page has now an updated date
          const date3 = await page.textContent('[data-testid="date-now"]')
          expect(date3).not.toBe(date2)

          // check json route
          const response3Json = await pollUntilHeadersMatch(
            new URL(`base/path/_next/data/build-id/de${pagePath}.json`, pageRouterBasePathI18n.url)
              .href,
            {
              headersToMatch: {
                // revalidate refreshes Next cache, but not CDN cache
                // so our request after revalidation means that Next cache is already
                // warmed up with fresh response, but CDN cache just knows that previously
                // cached response is stale, so we are hitting our function that serve
                // already cached response
                'cache-status': [/"Next.js"; hit/m, /"Netlify Edge"; fwd=(miss|stale)/m],
              },
              headersNotMatchedMessage:
                'Third request to tested page (data) should be a miss or stale on the Edge and hit in Next.js after on-demand revalidation',
            },
          )
          const headers3Json = response3Json?.headers() || {}
          expect(response3Json?.status()).toBe(200)
          expect(headers3Json['x-nextjs-cache']).toBeUndefined()
          if (!headers3Json['cache-status'].includes('"Netlify Edge"; hit')) {
            // if we missed CDN cache, we will see Next cache hit status
            // as we reuse cached response
            expect(headers3Json['cache-status']).toMatch(/"Next.js"; hit/m)
          }
          expect(headers3Json['netlify-cdn-cache-control']).toBe(
            nextVersionSatisfies('>=15.0.0-canary.187')
              ? 's-maxage=31536000, durable'
              : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
          )

          const data3 = (await response3Json?.json()) || {}
          expect(data3?.pageProps?.time).toBe(date3)
        })
      })
    }
  })

  test('requesting a non existing page route that needs to be fetched from the blob store like 404.html', async ({
    page,
    pageRouter,
  }) => {
    const response = await page.goto(new URL('non-existing', pageRouter.url).href)
    const headers = response?.headers() || {}
    expect(response?.status()).toBe(404)

    expect(await page.textContent('h1')).toBe('404')

    // https://github.com/vercel/next.js/pull/69802 made changes to returned cache-control header,
    // after that 404 pages would have `private` directive, before that it would not
    const shouldHavePrivateDirective = nextVersionSatisfies('^14.2.10 || >=15.0.0-canary.147')
    expect(headers['netlify-cdn-cache-control']).toBe(
      (shouldHavePrivateDirective ? 'private, ' : '') +
        'no-cache, no-store, max-age=0, must-revalidate, durable',
    )
    expect(headers['cache-control']).toBe(
      (shouldHavePrivateDirective ? 'private,' : '') +
        'no-cache,no-store,max-age=0,must-revalidate',
    )
  })

  test('requesting a non existing page route that needs to be fetched from the blob store like 404.html (notFound: true)', async ({
    page,
    pageRouter,
  }) => {
    const response = await page.goto(new URL('static/not-found', pageRouter.url).href)
    const headers = response?.headers() || {}
    expect(response?.status()).toBe(404)

    expect(await page.textContent('h1')).toBe('404')

    expect(headers['netlify-cdn-cache-control']).toBe(
      nextVersionSatisfies('>=15.0.0-canary.187')
        ? 's-maxage=31536000, durable'
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    )
    expect(headers['cache-control']).toBe('public,max-age=0,must-revalidate')
  })
})
