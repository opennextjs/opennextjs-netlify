import { expect } from '@playwright/test'
import { test } from '../utils/playwright-helpers.js'

test.describe('Dynamic CMS', () => {
  test.describe('Invalidates 404 pages from durable cache', () => {
    // using postFix allows to rerun tests without having to redeploy the app because paths/keys will be unique for each test run
    const postFix = Date.now()
    for (const { label, contentKey, expectedCacheTag, urlPath, pathToRevalidate } of [
      {
        label: 'Invalidates 404 html from durable cache (implicit default locale)',
        urlPath: `/content/html-implicit-default-locale-${postFix}`,
        contentKey: `html-implicit-default-locale-${postFix}`,
        expectedCacheTag: `_n_t_/en/content/html-implicit-default-locale-${postFix}`,
      },
      {
        label: 'Invalidates 404 html from durable cache (explicit default locale)',
        urlPath: `/en/content/html-explicit-default-locale-${postFix}`,
        contentKey: `html-explicit-default-locale-${postFix}`,
        expectedCacheTag: `_n_t_/en/content/html-explicit-default-locale-${postFix}`,
      },
      // json paths don't have implicit locale routing
      {
        label: 'Invalidates 404 json from durable cache (default locale)',
        urlPath: `/_next/data/build-id/en/content/json-default-locale-${postFix}.json`,
        // for html, we can use html path as param for revalidate,
        // for json we can't use json path and instead use one of html paths
        // let's use implicit default locale here, as we will have another case for
        // non-default locale which will have to use explicit one
        pathToRevalidate: `/content/json-default-locale-${postFix}`,
        contentKey: `json-default-locale-${postFix}`,
        expectedCacheTag: `_n_t_/en/content/json-default-locale-${postFix}`,
      },
      {
        label: 'Invalidates 404 html from durable cache (non-default locale)',
        urlPath: `/fr/content/html-non-default-locale-${postFix}`,
        contentKey: `html-non-default-locale-${postFix}`,
        expectedCacheTag: `_n_t_/fr/content/html-non-default-locale-${postFix}`,
      },
      {
        label: 'Invalidates 404 json from durable cache (non-default locale)',
        urlPath: `/_next/data/build-id/fr/content/json-non-default-locale-${postFix}.json`,
        pathToRevalidate: `/fr/content/json-non-default-locale-${postFix}`,
        contentKey: `json-non-default-locale-${postFix}`,
        expectedCacheTag: `_n_t_/fr/content/json-non-default-locale-${postFix}`,
      },
    ]) {
      test(label, async ({ page, dynamicCms }) => {
        const routeUrl = new URL(urlPath, dynamicCms.url).href
        const revalidateAPiUrl = new URL(
          `/api/revalidate?path=${pathToRevalidate ?? urlPath}`,
          dynamicCms.url,
        ).href

        // 1. Verify the status and headers of the dynamic page
        const response1 = await page.goto(routeUrl)
        const headers1 = response1?.headers() || {}

        expect(response1?.status()).toEqual(404)
        expect(headers1['cache-control']).toEqual('public,max-age=0,must-revalidate')
        expect(headers1['cache-status']).toMatch(
          /"Next.js"; fwd=miss\s*(,|\n)\s*"Netlify Durable"; fwd=uri-miss; stored\s*(, |\n)\s*"Netlify Edge"; fwd=miss/,
        )
        expect(headers1['debug-netlify-cache-tag']).toEqual(expectedCacheTag)
        expect(headers1['debug-netlify-cdn-cache-control']).toMatch(
          /(max-age|s-maxage)=31536000,( stale-while-revalidate=31536000,)? durable/,
        )

        // 2. Publish the content blob, revalidate the dynamic page, and wait to regenerate
        await fetch(new URL(`/cms/${contentKey}`, dynamicCms.url), {
          method: 'PUT',
          body: JSON.stringify({ props: { content: true } }),
          headers: {
            'Content-Type': 'application/json',
          },
        })
        await fetch(revalidateAPiUrl)
        await page.waitForTimeout(1000)

        // 3. Verify the status and headers of the dynamic page
        const response2 = await page.goto(routeUrl)
        const headers2 = response2?.headers() || {}

        expect(response2?.status()).toEqual(200)
        expect(headers2['cache-control']).toEqual('public,max-age=0,must-revalidate')
        expect(headers2['cache-status']).toMatch(
          /"Next.js"; hit\s*(,|\n)\s*"Netlify Durable"; fwd=stale; ttl=[0-9]+; stored\s*(,|\n)\s*"Netlify Edge"; fwd=(stale|miss)/,
        )
        expect(headers2['debug-netlify-cache-tag']).toEqual(expectedCacheTag)
        expect(headers2['debug-netlify-cdn-cache-control']).toMatch(
          /(max-age|s-maxage)=31536000,( stale-while-revalidate=31536000,)? durable/,
        )

        // 4. Unpublish the content blob, revalidate the dynamic page, and wait to regenerate
        await fetch(new URL(`/cms/${contentKey}`, dynamicCms.url), {
          method: 'DELETE',
        })
        await fetch(revalidateAPiUrl)
        await page.waitForTimeout(1000)

        // 5. Verify the status and headers of the dynamic page
        const response3 = await page.goto(routeUrl)
        const headers3 = response3?.headers() || {}

        expect(response3?.status()).toEqual(404)
        expect(headers3['cache-control']).toEqual('public,max-age=0,must-revalidate')
        expect(headers3['cache-status']).toMatch(
          /"Next.js"; fwd=miss\s*(,|\n)\s*"Netlify Durable"; fwd=stale; ttl=[0-9]+; stored\s*(,|\n)\s*"Netlify Edge"; fwd=(stale|miss)/,
        )
        expect(headers3['debug-netlify-cache-tag']).toEqual(expectedCacheTag)
        expect(headers3['debug-netlify-cdn-cache-control']).toMatch(
          /(max-age|s-maxage)=31536000,( stale-while-revalidate=31536000,)? durable/,
        )
      })
    }
  })

  test.describe('Invalidates getStaticProps redirect from durable cache', () => {
    // using postFix allows to rerun tests without having to redeploy the app because paths/keys will be unique for each test run
    const postFix = Date.now()
    for (const { label, contentKey, expectedCacheTag, urlPath, pathToRevalidate, isPageData } of [
      {
        label:
          'Invalidates canonical path getStaticProps redirect from durable cache (implicit default locale)',
        urlPath: `/content/html-implicit-default-locale-${postFix}`,
        contentKey: `html-implicit-default-locale-${postFix}`,
        expectedCacheTag: `_n_t_/en/content/html-implicit-default-locale-${postFix}`,
        isPageData: false,
      },
      {
        label:
          'Invalidates canonical path getStaticProps redirect from durable cache (explicit default locale)',
        urlPath: `/en/content/html-explicit-default-locale-${postFix}`,
        contentKey: `html-explicit-default-locale-${postFix}`,
        expectedCacheTag: `_n_t_/en/content/html-explicit-default-locale-${postFix}`,
        isPageData: false,
      },
      // // json paths don't have implicit locale routing
      {
        label:
          'Invalidates page data path getStaticProps redirect from durable cache (default locale)',
        urlPath: `/_next/data/build-id/en/content/json-default-locale-${postFix}.json`,
        // for html, we can use html path as param for revalidate,
        // for json we can't use json path and instead use one of html paths
        // let's use implicit default locale here, as we will have another case for
        // non-default locale which will have to use explicit one
        pathToRevalidate: `/content/json-default-locale-${postFix}`,
        contentKey: `json-default-locale-${postFix}`,
        expectedCacheTag: `_n_t_/en/content/json-default-locale-${postFix}`,
        isPageData: true,
      },
      {
        label:
          'Invalidates canonical path getStaticProps redirect from durable cache (non-default locale)',
        urlPath: `/fr/content/html-non-default-locale-${postFix}`,
        contentKey: `html-non-default-locale-${postFix}`,
        expectedCacheTag: `_n_t_/fr/content/html-non-default-locale-${postFix}`,
        isPageData: false,
      },
      {
        label:
          'Invalidates page data path getStaticProps redirect from durable cache (non-default locale)',
        urlPath: `/_next/data/build-id/fr/content/json-non-default-locale-${postFix}.json`,
        pathToRevalidate: `/fr/content/json-non-default-locale-${postFix}`,
        contentKey: `json-non-default-locale-${postFix}`,
        expectedCacheTag: `_n_t_/fr/content/json-non-default-locale-${postFix}`,
        isPageData: true,
      },
    ]) {
      test(label, async ({ page, dynamicCms }) => {
        const routeUrl = new URL(urlPath, dynamicCms.url).href
        const revalidateAPiUrl = new URL(
          `/api/revalidate?path=${pathToRevalidate ?? urlPath}`,
          dynamicCms.url,
        ).href

        // 1. Publish the redirect blob
        const initialRedirectDestination = '/initial-redirect-destination'
        await fetch(new URL(`/cms/${contentKey}`, dynamicCms.url), {
          method: 'PUT',
          body: JSON.stringify({
            redirect: { permanent: false, destination: initialRedirectDestination },
          }),
          headers: { 'Content-Type': 'application/json' },
        })
        await page.waitForTimeout(1000)

        // 2. Verify the status and headers of the route
        const response1 = await fetch(routeUrl, {
          redirect: 'manual',
          headers: {
            'x-nf-debug-logging': '1',
          },
        })

        if (isPageData) {
          // page data routes do return 200, but contain redirect information in the body
          expect(response1.status).toEqual(200)
          const json = await response1.json()
          expect(json?.pageProps?.['__N_REDIRECT']).toEqual(initialRedirectDestination)
          expect(json?.pageProps?.['__N_REDIRECT_STATUS']).toEqual(307)
        } else {
          expect(response1.status).toEqual(307)
          expect(response1.headers.get('location')).toEqual(initialRedirectDestination)
        }

        expect(response1.headers.get('cache-control')).toEqual('public,max-age=0,must-revalidate')
        expect(response1.headers.get('cache-status')).toMatch(
          /"Next.js"; fwd=miss\s*(,|\n)\s*"Netlify Durable"; fwd=uri-miss; stored\s*(, |\n)\s*"Netlify Edge"; fwd=miss/,
        )
        expect(response1.headers.get('debug-netlify-cache-tag')).toEqual(expectedCacheTag)
        expect(response1.headers.get('debug-netlify-cdn-cache-control')).toMatch(
          /(max-age|s-maxage)=31536000,( stale-while-revalidate=31536000,)? durable/,
        )

        // 3. Publish the redirect blob with updated destination, revalidate the dynamic page, and wait to regenerate
        const updatedRedirectDestination = '/updated-redirect-destination'
        await fetch(new URL(`/cms/${contentKey}`, dynamicCms.url), {
          method: 'PUT',
          body: JSON.stringify({
            redirect: { permanent: false, destination: updatedRedirectDestination },
            // we'll also use revalidate option here to test this as well
            revalidate: 600,
          }),
          headers: { 'Content-Type': 'application/json' },
        })
        await fetch(revalidateAPiUrl)
        await page.waitForTimeout(1000)

        // 4. Verify the status and headers of the route
        const response2 = await fetch(routeUrl, {
          redirect: 'manual',
          headers: {
            'x-nf-debug-logging': '1',
          },
        })

        if (isPageData) {
          // page data routes do return 200, but contain redirect information in the body
          expect(response2.status).toEqual(200)
          const json = await response2.json()
          expect(json?.pageProps?.['__N_REDIRECT']).toEqual(updatedRedirectDestination)
          expect(json?.pageProps?.['__N_REDIRECT_STATUS']).toEqual(307)
        } else {
          expect(response2.status).toEqual(307)
          expect(response2.headers.get('location')).toEqual(updatedRedirectDestination)
        }

        expect(response2.headers.get('cache-control')).toEqual('public,max-age=0,must-revalidate')
        expect(response2.headers.get('cache-status')).toMatch(
          /"Next.js"; hit\s*(,|\n)\s*"Netlify Durable"; fwd=stale; ttl=[0-9]+; stored\s*(,|\n)\s*"Netlify Edge"; fwd=(stale|miss)/,
        )
        expect(response2.headers.get('debug-netlify-cache-tag')).toEqual(expectedCacheTag)
        expect(response2.headers.get('debug-netlify-cdn-cache-control')).toMatch(
          /(max-age|s-maxage)=600,( stale-while-revalidate=[0-9]+,)? durable/,
        )
      })
    }
  })
})
