import { expect } from '@playwright/test'
import { test } from '../utils/playwright-helpers.js'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'

test.describe('app router on-demand revalidation', () => {
  for (const { label, prerendered, pagePath, revalidateApiPath, expectedH1Content } of [
    {
      label: 'revalidatePath (prerendered page with static path)',
      prerendered: true,
      pagePath: '/static-fetch-1',
      revalidateApiPath: '/api/on-demand-revalidate/path?path=/static-fetch-1',
      expectedH1Content: 'Hello, Static Fetch 1',
    },
    {
      label: 'revalidateTag (prerendered page with static path)',
      prerendered: true,
      pagePath: '/static-fetch-2',
      revalidateApiPath: '/api/on-demand-revalidate/tag?tag=collection',
      expectedH1Content: 'Hello, Static Fetch 2',
    },
    {
      label: 'revalidatePath (prerendered page with dynamic path)',
      prerendered: true,
      pagePath: '/static-fetch/1',
      revalidateApiPath: '/api/on-demand-revalidate/path?path=/static-fetch/1',
      expectedH1Content: 'Hello, Statically fetched show 1',
    },
    {
      label: 'revalidateTag (prerendered page with dynamic path)',
      prerendered: true,
      pagePath: '/static-fetch/2',
      revalidateApiPath: '/api/on-demand-revalidate/tag?tag=show-2',
      expectedH1Content: 'Hello, Statically fetched show 2',
    },
    {
      label: 'revalidatePath (not prerendered page with dynamic path)',
      prerendered: false,
      pagePath: '/static-fetch/3',
      revalidateApiPath: '/api/on-demand-revalidate/path?path=/static-fetch/3',
      expectedH1Content: 'Hello, Statically fetched show 3',
    },
    {
      label: 'revalidateTag (not prerendered page with dynamic path)',
      prerendered: false,
      pagePath: '/static-fetch/4',
      revalidateApiPath: '/api/on-demand-revalidate/tag?tag=show-4',
      expectedH1Content: 'Hello, Statically fetched show 4',
    },
    {
      label: 'revalidatePath (prerendered page with dynamic path) - non-ASCII variant',
      prerendered: true,
      pagePath: '/product/事前レンダリング,test',
      revalidateApiPath: `/api/on-demand-revalidate/path?path=/product/事前レンダリング,test`,
      expectedH1Content: 'Product 事前レンダリング,test',
    },
    {
      label: 'revalidatePath (not prerendered page with dynamic path) - non-ASCII variant',
      prerendered: false,
      pagePath: '/product/事前レンダリングされていない,test',
      revalidateApiPath: `/api/on-demand-revalidate/path?path=/product/事前レンダリングされていない,test`,
      expectedH1Content: 'Product 事前レンダリングされていない,test',
    },
  ]) {
    test(label, async ({ page, pollUntilHeadersMatch, serverComponents }) => {
      // in case there is retry or some other test did hit that path before
      // we want to make sure that cdn cache is not warmed up
      const purgeCdnCache = await page.goto(
        new URL(`/api/purge-cdn?path=${pagePath}`, serverComponents.url).href,
      )
      expect(purgeCdnCache?.status()).toBe(200)

      // wait a bit until cdn cache purge propagates
      await page.waitForTimeout(500)

      const response1 = await pollUntilHeadersMatch(new URL(pagePath, serverComponents.url).href, {
        headersToMatch: {
          // either first time hitting this route or we invalidated
          // just CDN node in earlier step
          // we will invoke function and see Next cache hit status
          // in the response if it was prerendered at build time
          // or regenerated in previous attempt to run this test
          'cache-status': [
            /"Netlify Edge"; fwd=(miss|stale)/m,
            prerendered ? /"Next.js"; hit/m : /"Next.js"; (hit|fwd=miss)/m,
          ],
        },
        headersNotMatchedMessage:
          'First request to tested page should be a miss or stale on the Edge and hit in Next.js',
      })
      const headers1 = response1?.headers() || {}
      expect(response1?.status()).toBe(200)
      expect(headers1['x-nextjs-cache']).toBeUndefined()
      expect(headers1['debug-netlify-cdn-cache-control']).toBe(
        nextVersionSatisfies('>=15.0.0-canary.187')
          ? 's-maxage=31536000, durable'
          : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
      )

      const date1 = await page.getByTestId("date-now").textContent()

      const h1 = await page.locator('h1').textContent()
      expect(h1).toBe(expectedH1Content)

      const response2 = await pollUntilHeadersMatch(new URL(pagePath, serverComponents.url).href, {
        headersToMatch: {
          // we are hitting the same page again and we most likely will see
          // CDN hit (in this case Next reported cache status is omitted
          // as it didn't actually take place in handling this request)
          // or we will see CDN miss because different CDN node handled request
          'cache-status': /"Netlify Edge"; (hit|fwd=miss|fwd=stale)/m,
        },
        headersNotMatchedMessage:
          'Second request to tested page should most likely be a hit on the Edge (optionally miss or stale if different CDN node)',
      })
      const headers2 = response2?.headers() || {}
      expect(response2?.status()).toBe(200)
      expect(headers2['x-nextjs-cache']).toBeUndefined()
      if (!headers2['cache-status'].includes('"Netlify Edge"; hit')) {
        // if we missed CDN cache, we will see Next cache hit status
        // as we reuse cached response
        expect(headers2['cache-status']).toMatch(/"Next.js"; hit/m)
      }
      expect(headers2['debug-netlify-cdn-cache-control']).toBe(
        nextVersionSatisfies('>=15.0.0-canary.187')
          ? 's-maxage=31536000, durable'
          : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
      )

      // the page is cached
      const date2 = await page.getByTestId("date-now").textContent()
      expect(date2).toBe(date1)

      const revalidate = await page.goto(new URL(revalidateApiPath, serverComponents.url).href)
      expect(revalidate?.status()).toBe(200)

      // wait a bit until cdn tags and invalidated and cdn is purged
      await page.waitForTimeout(500)

      // now after the revalidation it should have a different date
      const response3 = await pollUntilHeadersMatch(new URL(pagePath, serverComponents.url).href, {
        headersToMatch: {
          // revalidatePath just marks the page(s) as invalid and does NOT
          // automatically refreshes the cache. This request will cause
          // Next.js cache miss and new response will be generated and cached
          // Depending if we hit same CDN node as previous request, we might
          // get either fwd=miss or fwd=stale
          'cache-status': [/"Next.js"; fwd=miss/m, /"Netlify Edge"; fwd=(miss|stale)/m],
        },
        headersNotMatchedMessage:
          'Third request to tested page should be a miss or stale on the Edge and miss in Next.js after on-demand revalidation',
      })
      const headers3 = response3?.headers() || {}
      expect(response3?.status()).toBe(200)
      expect(headers3?.['x-nextjs-cache']).toBeUndefined()
      expect(headers3['debug-netlify-cdn-cache-control']).toBe(
        nextVersionSatisfies('>=15.0.0-canary.187')
          ? 's-maxage=31536000, durable'
          : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
      )

      // the page has now an updated date
      const date3 = await page.getByTestId("date-now").textContent()
      expect(date3).not.toBe(date2)

      const response4 = await pollUntilHeadersMatch(new URL(pagePath, serverComponents.url).href, {
        headersToMatch: {
          // we are hitting the same page again and we most likely will see
          // CDN hit (in this case Next reported cache status is omitted
          // as it didn't actually take place in handling this request)
          // or we will see CDN miss because different CDN node handled request
          'cache-status': /"Netlify Edge"; (hit|fwd=miss|fwd=stale)/m,
        },
        headersNotMatchedMessage:
          'Fourth request  to tested page should most likely be a hit on the Edge (optionally miss or stale if different CDN node)',
      })
      const headers4 = response4?.headers() || {}
      expect(response4?.status()).toBe(200)
      expect(headers4?.['x-nextjs-cache']).toBeUndefined()
      if (!headers4['cache-status'].includes('"Netlify Edge"; hit')) {
        // if we missed CDN cache, we will see Next cache hit status
        // as we reuse cached response
        expect(headers4['cache-status']).toMatch(/"Next.js"; hit/m)
      }
      expect(headers4['debug-netlify-cdn-cache-control']).toBe(
        nextVersionSatisfies('>=15.0.0-canary.187')
          ? 's-maxage=31536000, durable'
          : 's-maxage=31536000, stale-while-revalidate=31536000, durable',
      )

      // the page is cached
      const date4 = await page.getByTestId("date-now").textContent()
      expect(date4).toBe(date3)
    })
  }
})
