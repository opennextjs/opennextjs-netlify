import { expect } from '@playwright/test'
import { test } from '../utils/playwright-helpers.js'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'

// `ppr` fixture uses `cacheComponents` on Next 16+ (and `experimental.ppr` on older canaries)
if (nextVersionSatisfies('>=16.0.0-alpha.0')) {
  test.describe('cacheComponents', () => {
    test.describe.configure({ mode: 'parallel' })

    for (const { label, pagePath, h1, cdnCacheControl } of [
      {
        label: 'fully static page',
        pagePath: '/',
        h1: 'Home',
        cdnCacheControl: /(max-age|s-maxage)=31536000, durable/,
      },
      {
        label: 'fully "use cache" page with cacheLife',
        pagePath: '/use-cache',
        h1: 'Use cache page',
        cdnCacheControl: /s-maxage=60, stale-while-revalidate=3540, durable/,
      },
    ]) {
      test(`${label} has no postponed state and is cacheable on CDN`, async ({
        page,
        pollUntilHeadersMatch,
        ppr,
      }) => {
        // prerendered pages with TTL are served stale on the first request while revalidating in
        // background, so poll until the response carries the expected CDN cache control
        const response1 = await pollUntilHeadersMatch(new URL(pagePath, ppr.url).href, {
          headersToMatch: {
            'debug-netlify-cdn-cache-control': cdnCacheControl,
          },
          headersNotMatchedMessage:
            'Page should be served with CDN cache control derived from cacheLife',
        })
        const headers1 = response1?.headers() || {}
        expect(response1?.status()).toBe(200)
        expect(headers1['x-nextjs-postponed']).toBeUndefined()
        await expect(page.locator('h1')).toHaveText(h1)

        const response2 = await pollUntilHeadersMatch(new URL(pagePath, ppr.url).href, {
          headersToMatch: {
            // most likely CDN hit, or miss/stale if a different CDN node handled the request
            'cache-status': /"Netlify Edge"; (hit|fwd=miss|fwd=stale)/m,
          },
          headersNotMatchedMessage: 'Second request should be served by the CDN',
        })
        const headers2 = response2?.headers() || {}
        expect(response2?.status()).toBe(200)
        expect(headers2['x-nextjs-postponed']).toBeUndefined()
        if (!headers2['cache-status'].includes('"Netlify Edge"; hit')) {
          // if we missed CDN cache, function should reuse prerendered response
          expect(headers2['cache-status']).toMatch(/"Next.js"; hit/m)
        }
        expect(headers2['debug-netlify-cdn-cache-control']).toMatch(cdnCacheControl)
      })
    }

    for (const { label, pagePath, h1, dynamicTestId, cachedTestId } of [
      {
        label: 'static route with dynamic hole',
        pagePath: '/mixed',
        h1: 'Mixed page',
        dynamicTestId: 'dynamic-date-now',
        cachedTestId: 'cached-date-now',
      },
      {
        label: 'prerendered dynamic route param',
        pagePath: '/static-params/1',
        h1: 'Dynamic Page (static params): 1',
        dynamicTestId: 'date-now',
      },
      {
        label: 'not prerendered dynamic route param (fallback shell)',
        pagePath: '/static-params/3',
        h1: 'Dynamic Page (static params): 3',
        dynamicTestId: 'date-now',
      },
      {
        label: 'dynamic route without generateStaticParams',
        pagePath: '/dynamic-params/123',
        h1: 'Dynamic Page (dynamic params): 123',
        dynamicTestId: 'date-now',
      },
    ]) {
      test(`${label} streams dynamic part and is not cacheable on CDN`, async ({ page, ppr }) => {
        const url = new URL(pagePath, ppr.url).href

        const response1 = await page.goto(url)
        const headers1 = response1?.headers() || {}
        expect(response1?.status()).toBe(200)
        expect(headers1['x-nextjs-postponed']).toBe('1')
        expect(headers1['debug-netlify-cdn-cache-control']).toMatch(/no-store/)
        expect(headers1['cache-status']).not.toMatch(/"Netlify Edge"; hit/m)
        await expect(page.locator('h1')).toHaveText(h1)
        await expect(page.getByTestId(dynamicTestId)).not.toBeEmpty()
        const dynamicDate1 = await page.getByTestId(dynamicTestId).textContent()
        const cachedDate1 = cachedTestId ? await page.getByTestId(cachedTestId).textContent() : null

        const response2 = await page.goto(url)
        const headers2 = response2?.headers() || {}
        expect(response2?.status()).toBe(200)
        expect(headers2['x-nextjs-postponed']).toBe('1')
        expect(headers2['cache-status']).not.toMatch(/"Netlify Edge"; hit/m)
        await expect(page.getByTestId(dynamicTestId)).not.toBeEmpty()
        const dynamicDate2 = await page.getByTestId(dynamicTestId).textContent()
        expect(dynamicDate2, 'dynamic part should be rendered on each request').not.toBe(
          dynamicDate1,
        )
        if (cachedTestId) {
          let cachedDate2 = await page.getByTestId(cachedTestId).textContent()
          if (cachedDate2 !== cachedDate1) {
            // build-time shell has TTL and is served stale on first request, which triggers
            // background revalidation and re-executes "use cache" function, so allow one change
            await page.goto(url)
            const cachedDate3 = await page.getByTestId(cachedTestId).textContent()
            expect(cachedDate3, '"use cache" part should be reused from static shell').toBe(
              cachedDate2,
            )
          }
        }
      })
    }
  })
}
