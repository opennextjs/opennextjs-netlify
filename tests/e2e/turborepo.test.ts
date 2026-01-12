import { expect } from '@playwright/test'
import { test } from '../utils/playwright-helpers.js'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'

// those tests have different fixtures and can run in parallel
test.describe.configure({ mode: 'parallel' })

test.describe('[PNPM] Package manager', () => {
  test('Static revalidate works correctly', async ({ page, pollUntilHeadersMatch, turborepo }) => {
    // in case there is retry or some other test did hit that path before
    // we want to make sure that cdn cache is not warmed up
    const purgeCdnCache = await page.goto(
      new URL('/api/purge-cdn?path=/static/revalidate-manual', turborepo.url).href,
    )
    expect(purgeCdnCache?.status()).toBe(200)

    // wait a bit until cdn cache purge propagates
    await page.waitForTimeout(500)

    const response1 = await pollUntilHeadersMatch(
      new URL('static/revalidate-manual', turborepo.url).href,
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
          'First request to tested page (html) should be a miss or stale on the Edge and hit in Next.js',
      },
    )
    const headers1 = response1?.headers() || {}
    expect(response1?.status()).toBe(200)
    expect(headers1['x-nextjs-cache']).toBeUndefined()
    expect(headers1['debug-netlify-cdn-cache-control']).toMatch(
      nextVersionSatisfies('>=15.0.0-canary.187')
        ? /(max-age|s-maxage)=31536000/
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    )

    const date1 = await page.getByTestId('date-now').textContent()
    const h1 = await page.locator('h1').textContent()
    expect(h1).toBe('Show #71')

    const response2 = await pollUntilHeadersMatch(
      new URL('static/revalidate-manual', turborepo.url).href,
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
    expect(headers2['debug-netlify-cdn-cache-control']).toMatch(
      nextVersionSatisfies('>=15.0.0-canary.187')
        ? /(max-age|s-maxage)=31536000/
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    )

    // the page is cached
    const date2 = await page.getByTestId('date-now').textContent()
    expect(date2).toBe(date1)

    const revalidate = await page.goto(new URL('/api/revalidate', turborepo.url).href)
    expect(revalidate?.status()).toBe(200)

    // wait a bit until the page got regenerated
    await page.waitForTimeout(1000)

    // now after the revalidation it should have a different date
    const response3 = await pollUntilHeadersMatch(
      new URL('static/revalidate-manual', turborepo.url).href,
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
    const date3 = await page.getByTestId('date-now').textContent()
    expect(date3).not.toBe(date2)
  })

  test('transitive external dependencies are supported', async ({ page, turborepo }) => {
    const pageResponse = await page.goto(new URL('/transitive-external-deps', turborepo.url).href)

    expect(pageResponse?.status()).toBe(200)

    await expect(page.getByTestId('dep-a-version')).toHaveText('3.10.1')
    await expect(page.getByTestId('dep-b-version')).toHaveText('4.17.21')
  })
})

test.describe('[NPM] Package manager', () => {
  test('Static revalidate works correctly', async ({
    page,
    pollUntilHeadersMatch,
    turborepoNPM,
  }) => {
    // in case there is retry or some other test did hit that path before
    // we want to make sure that cdn cache is not warmed up
    const purgeCdnCache = await page.goto(
      new URL('/api/purge-cdn?path=/static/revalidate-manual', turborepoNPM.url).href,
    )
    expect(purgeCdnCache?.status()).toBe(200)

    // wait a bit until cdn cache purge propagates
    await page.waitForTimeout(500)

    const response1 = await pollUntilHeadersMatch(
      new URL('static/revalidate-manual', turborepoNPM.url).href,
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
          'First request to tested page (html) should be a miss or stale on the Edge and hit in Next.js',
      },
    )
    const headers1 = response1?.headers() || {}
    expect(response1?.status()).toBe(200)
    expect(headers1['x-nextjs-cache']).toBeUndefined()
    expect(headers1['debug-netlify-cdn-cache-control']).toMatch(
      nextVersionSatisfies('>=15.0.0-canary.187')
        ? /(max-age|s-maxage)=31536000/
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    )

    const date1 = await page.getByTestId('date-now').textContent()
    const h1 = await page.locator('h1').textContent()
    expect(h1).toBe('Show #71')

    const response2 = await pollUntilHeadersMatch(
      new URL('static/revalidate-manual', turborepoNPM.url).href,
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
    expect(headers2['debug-netlify-cdn-cache-control']).toMatch(
      nextVersionSatisfies('>=15.0.0-canary.187')
        ? /(max-age|s-maxage)=31536000/
        : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
    )

    // the page is cached
    const date2 = await page.getByTestId('date-now').textContent()
    expect(date2).toBe(date1)

    const revalidate = await page.goto(new URL('/api/revalidate', turborepoNPM.url).href)
    expect(revalidate?.status()).toBe(200)

    // wait a bit until the page got regenerated
    await page.waitForTimeout(1000)

    // now after the revalidation it should have a different date
    const response3 = await pollUntilHeadersMatch(
      new URL('static/revalidate-manual', turborepoNPM.url).href,
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
    const date3 = await page.getByTestId('date-now').textContent()
    expect(date3).not.toBe(date2)
  })

  test('environment variables from .env files should be available for functions', async ({
    turborepoNPM,
  }) => {
    const response = await fetch(`${turborepoNPM.url}/api/env`)
    const data = await response.json()
    expect(data).toEqual({
      '.env': 'defined in .env',
      '.env.local': 'defined in .env.local',
      '.env.production': 'defined in .env.production',
      '.env.production.local': 'defined in .env.production.local',
    })
  })

  test('transitive external dependencies are supported', async ({ page, turborepoNPM }) => {
    const pageResponse = await page.goto(
      new URL('/transitive-external-deps', turborepoNPM.url).href,
    )

    expect(pageResponse?.status()).toBe(200)

    await expect(page.getByTestId('dep-a-version')).toHaveText('3.10.1')
    await expect(page.getByTestId('dep-b-version')).toHaveText('4.17.21')
  })
})
