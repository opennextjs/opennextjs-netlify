import { expect } from '@playwright/test'
import { test } from '../utils/playwright-helpers.js'

test.describe('Dynamic CMS', () => {
  test('Invalidates 404 pages from durable cache', async ({ page, dynamicCms }) => {
    // 1. Verify the status and headers of the dynamic page
    const response1 = await page.goto(new URL('/content/blog', dynamicCms.url).href)
    const headers1 = response1?.headers() || {}

    expect(response1?.status()).toEqual(404)
    expect(headers1['cache-control']).toEqual('public,max-age=0,must-revalidate')
    expect(headers1['cache-status']).toEqual(
      '"Next.js"; fwd=miss, "Netlify Durable"; fwd=uri-miss; stored, "Netlify Edge"; fwd=miss',
    )
    expect(headers1['netlify-cache-tag']).toEqual('_n_t_/content/blog')
    expect(headers1['netlify-cdn-cache-control']).toMatch(
      /s-maxage=31536000,( stale-while-revalidate=31536000,)? durable/
    )

    // 2. Publish the blob, revalidate the dynamic page, and wait to regenerate
    await page.goto(new URL('/cms/publish', dynamicCms.url).href)
    await page.goto(new URL('/api/revalidate?path=/content/blog', dynamicCms.url).href)
    await page.waitForTimeout(1000)

    // 3. Verify the status and headers of the dynamic page
    const response2 = await page.goto(new URL('/content/blog', dynamicCms.url).href)
    const headers2 = response2?.headers() || {}

    expect(response2?.status()).toEqual(200)
    expect(headers2['cache-control']).toEqual('public,max-age=0,must-revalidate')
    expect(headers2['cache-status']).toMatch(
      /"Next.js"; hit, "Netlify Durable"; fwd=stale; ttl=[0-9]+; stored, "Netlify Edge"; fwd=stale/,
    )
    expect(headers2['netlify-cache-tag']).toEqual('_n_t_/content/blog')
    expect(headers2['netlify-cdn-cache-control']).toMatch(
      /s-maxage=31536000,( stale-while-revalidate=31536000,)? durable/
    )

    // 4. Unpublish the blob, revalidate the dynamic page, and wait to regenerate
    await page.goto(new URL('/cms/unpublish', dynamicCms.url).href)
    await page.goto(new URL('/api/revalidate?path=/content/blog', dynamicCms.url).href)
    await page.waitForTimeout(1000)

    // 5. Verify the status and headers of the dynamic page
    const response3 = await page.goto(new URL('/content/blog', dynamicCms.url).href)
    const headers3 = response3?.headers() || {}

    expect(response3?.status()).toEqual(404)
    expect(headers3['cache-control']).toEqual('public,max-age=0,must-revalidate')
    expect(headers3['cache-status']).toMatch(
      /"Next.js"; fwd=miss, "Netlify Durable"; fwd=stale; ttl=[0-9]+; stored, "Netlify Edge"; fwd=stale/,
    )
    expect(headers3['netlify-cache-tag']).toEqual('_n_t_/content/blog')
    expect(headers3['netlify-cdn-cache-control']).toMatch(
      /s-maxage=31536000,( stale-while-revalidate=31536000,)? durable/
    )
  })
})
