import { expect, Response } from '@playwright/test'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'
import { test } from '../utils/playwright-helpers.js'
import { getImageSize } from 'next/dist/server/image-optimizer.js'

type ExtendedWindow = Window & {
  didReload?: boolean
}

test('Runs edge middleware', async ({ page, middleware }) => {
  await page.goto(`${middleware.url}/test/redirect`)

  await expect(page).toHaveTitle('Simple Next App')

  const h1 = page.locator('h1')
  await expect(h1).toHaveText('Other')
})

test('Does not run edge middleware at the origin', async ({ page, middleware }) => {
  const res = await page.goto(`${middleware.url}/test/next`)

  expect(await res?.headerValue('x-deno')).toBeTruthy()
  expect(await res?.headerValue('x-node')).toBeNull()

  await expect(page).toHaveTitle('Simple Next App')

  const h1 = page.locator('h1')
  await expect(h1).toHaveText('Message from middleware: hello')
})

test('does not run middleware again for rewrite target', async ({ page, middleware }) => {
  const direct = await page.goto(`${middleware.url}/test/rewrite-target`)
  expect(await direct?.headerValue('x-added-rewrite-target')).toBeTruthy()

  const rewritten = await page.goto(`${middleware.url}/test/rewrite-loop-detect`)

  expect(await rewritten?.headerValue('x-added-rewrite-target')).toBeNull()
  const h1 = page.locator('h1')
  await expect(h1).toHaveText('Hello rewrite')
})

test('Supports CJS dependencies in Edge Middleware', async ({ page, middleware }) => {
  const res = await page.goto(`${middleware.url}/test/next`)

  expect(await res?.headerValue('x-cjs-module-works')).toEqual('true')
})

// adaptation of https://github.com/vercel/next.js/blob/8aa9a52c36f338320d55bd2ec292ffb0b8c7cb35/test/e2e/app-dir/metadata-edge/index.test.ts#L24C5-L31C7
test('it should render OpenGraph image meta tag correctly', async ({ page, middlewareOg }) => {
  test.skip(!nextVersionSatisfies('>=14.0.0'), 'This test is only for Next.js 14+')
  await page.goto(`${middlewareOg.url}/`)
  const ogURL = await page.locator('meta[property="og:image"]').getAttribute('content')
  expect(ogURL).toBeTruthy()
  const ogResponse = await fetch(new URL(new URL(ogURL!).pathname, middlewareOg.url))
  const imageBuffer = await ogResponse.arrayBuffer()
  const size = await getImageSize(Buffer.from(imageBuffer), 'png')
  expect([size.width, size.height]).toEqual([1200, 630])
})

test.describe('json data', () => {
  const testConfigs = [
    {
      describeLabel: 'NextResponse.next() -> getServerSideProps page',
      selector: 'NextResponse.next()#getServerSideProps',
      jsonPathMatcher: '/link/next-getserversideprops.json',
    },
    {
      describeLabel: 'NextResponse.next() -> getStaticProps page',
      selector: 'NextResponse.next()#getStaticProps',
      jsonPathMatcher: '/link/next-getstaticprops.json',
    },
    {
      describeLabel: 'NextResponse.next() -> fully static page',
      selector: 'NextResponse.next()#fullyStatic',
      jsonPathMatcher: '/link/next-fullystatic.json',
    },
    {
      describeLabel: 'NextResponse.rewrite() -> getServerSideProps page',
      selector: 'NextResponse.rewrite()#getServerSideProps',
      jsonPathMatcher: '/link/rewrite-me-getserversideprops.json',
    },
    {
      describeLabel: 'NextResponse.rewrite() -> getStaticProps page',
      selector: 'NextResponse.rewrite()#getStaticProps',
      jsonPathMatcher: '/link/rewrite-me-getstaticprops.json',
    },
  ]

  // Linking to static pages reloads on rewrite for versions below 14
  if (nextVersionSatisfies('>=14.0.0')) {
    testConfigs.push({
      describeLabel: 'NextResponse.rewrite() -> fully static page',
      selector: 'NextResponse.rewrite()#fullyStatic',
      jsonPathMatcher: '/link/rewrite-me-fullystatic.json',
    })
  }

  test.describe('no 18n', () => {
    for (const testConfig of testConfigs) {
      test.describe(testConfig.describeLabel, () => {
        test('json data fetch', async ({ middlewarePages, page }) => {
          const dataFetchPromise = new Promise<Response>((resolve) => {
            page.on('response', (response) => {
              if (response.url().includes(testConfig.jsonPathMatcher)) {
                resolve(response)
              }
            })
          })

          await page.goto(`${middlewarePages.url}/link`)

          await page.hover(`[data-link="${testConfig.selector}"]`)

          const dataResponse = await dataFetchPromise

          expect(dataResponse.ok()).toBe(true)
        })

        test('navigation', async ({ middlewarePages, page }) => {
          await page.goto(`${middlewarePages.url}/link`)

          await page.evaluate(() => {
            // set some value to window to check later if browser did reload and lost this state
            ;(window as ExtendedWindow).didReload = false
          })

          await page.click(`[data-link="${testConfig.selector}"]`)

          // wait for page to be rendered
          await page.waitForSelector(`[data-page="${testConfig.selector}"]`)

          // check if browser navigation worked by checking if state was preserved
          const browserNavigationWorked =
            (await page.evaluate(() => {
              return (window as ExtendedWindow).didReload
            })) === false

          // we expect client navigation to work without browser reload
          expect(browserNavigationWorked).toBe(true)
        })
      })
    }
  })
  test.describe('with 18n', () => {
    for (const testConfig of testConfigs) {
      test.describe(testConfig.describeLabel, () => {
        for (const { localeLabel, pageWithLinksPathname } of [
          { localeLabel: 'implicit default locale', pageWithLinksPathname: '/link' },
          { localeLabel: 'explicit default locale', pageWithLinksPathname: '/en/link' },
          { localeLabel: 'explicit non-default locale', pageWithLinksPathname: '/fr/link' },
        ]) {
          test.describe(localeLabel, () => {
            test('json data fetch', async ({ middlewareI18n, page }) => {
              const dataFetchPromise = new Promise<Response>((resolve) => {
                page.on('response', (response) => {
                  if (response.url().includes(testConfig.jsonPathMatcher)) {
                    resolve(response)
                  }
                })
              })

              await page.goto(`${middlewareI18n.url}${pageWithLinksPathname}`)

              await page.hover(`[data-link="${testConfig.selector}"]`)

              const dataResponse = await dataFetchPromise

              expect(dataResponse.ok()).toBe(true)
            })

            test('navigation', async ({ middlewareI18n, page }) => {
              await page.goto(`${middlewareI18n.url}${pageWithLinksPathname}`)

              await page.evaluate(() => {
                // set some value to window to check later if browser did reload and lost this state
                ;(window as ExtendedWindow).didReload = false
              })

              await page.click(`[data-link="${testConfig.selector}"]`)

              // wait for page to be rendered
              await page.waitForSelector(`[data-page="${testConfig.selector}"]`)

              // check if browser navigation worked by checking if state was preserved
              const browserNavigationWorked =
                (await page.evaluate(() => {
                  return (window as ExtendedWindow).didReload
                })) === false

              // we expect client navigation to work without browser reload
              expect(browserNavigationWorked).toBe(true)
            })
          })
        }
      })
    }
  })
})

// those tests use `fetch` instead of `page.goto` intentionally to avoid potential client rendering
// hiding any potential edge/server issues
test.describe('Middleware with i18n and excluded paths', () => {
  const DEFAULT_LOCALE = 'en'

  /** helper function to extract JSON data from page rendering data with `<pre>{JSON.stringify(data)}</pre>` */
  function extractDataFromHtml(html: string): Record<string, any> {
    const match = html.match(/<pre>(?<rawInput>[^<]+)<\/pre>/)
    if (!match || !match.groups?.rawInput) {
      console.error('<pre> not found in html input', {
        html,
      })
      throw new Error('Failed to extract data from HTML')
    }

    const { rawInput } = match.groups
    const unescapedInput = rawInput.replaceAll('&quot;', '"')
    try {
      return JSON.parse(unescapedInput)
    } catch (originalError) {
      console.error('Failed to parse JSON', {
        originalError,
        rawInput,
        unescapedInput,
      })
    }
    throw new Error('Failed to extract data from HTML')
  }

  // those tests hit paths ending with `/json` which has special handling in middleware
  // to return JSON response from middleware itself
  test.describe('Middleware response path', () => {
    test('should match on non-localized not excluded page path', async ({
      middlewareI18nExcludedPaths,
    }) => {
      const response = await fetch(`${middlewareI18nExcludedPaths.url}/json`)

      expect(response.headers.get('x-test-used-middleware')).toBe('true')
      expect(response.status).toBe(200)

      const { nextUrlPathname, nextUrlLocale } = await response.json()

      expect(nextUrlPathname).toBe('/json')
      expect(nextUrlLocale).toBe(DEFAULT_LOCALE)
    })

    test('should match on localized not excluded page path', async ({
      middlewareI18nExcludedPaths,
    }) => {
      const response = await fetch(`${middlewareI18nExcludedPaths.url}/fr/json`)

      expect(response.headers.get('x-test-used-middleware')).toBe('true')
      expect(response.status).toBe(200)

      const { nextUrlPathname, nextUrlLocale } = await response.json()

      expect(nextUrlPathname).toBe('/json')
      expect(nextUrlLocale).toBe('fr')
    })
  })

  // those tests hit paths that don't end with `/json` while still satisfying middleware matcher
  // so middleware should pass them through to origin
  test.describe('Middleware passthrough', () => {
    test('should match on non-localized not excluded page path', async ({
      middlewareI18nExcludedPaths,
    }) => {
      const response = await fetch(`${middlewareI18nExcludedPaths.url}/html`)

      expect(response.headers.get('x-test-used-middleware')).toBe('true')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/text\/html/)

      const html = await response.text()
      const { locale, params } = extractDataFromHtml(html)

      expect(params).toMatchObject({ catchall: ['html'] })
      expect(locale).toBe(DEFAULT_LOCALE)
    })

    test('should match on localized not excluded page path', async ({
      middlewareI18nExcludedPaths,
    }) => {
      const response = await fetch(`${middlewareI18nExcludedPaths.url}/fr/html`)

      expect(response.headers.get('x-test-used-middleware')).toBe('true')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/text\/html/)

      const html = await response.text()
      const { locale, params } = extractDataFromHtml(html)

      expect(params).toMatchObject({ catchall: ['html'] })
      expect(locale).toBe('fr')
    })
  })

  // those tests hit paths that don't satisfy middleware matcher, so should go directly to origin
  // without going through middleware
  test.describe('Middleware skipping (paths not satisfying middleware matcher)', () => {
    test('should NOT match on non-localized excluded API path', async ({
      middlewareI18nExcludedPaths,
    }) => {
      const response = await fetch(`${middlewareI18nExcludedPaths.url}/api/html`)

      expect(response.headers.get('x-test-used-middleware')).not.toBe('true')
      expect(response.status).toBe(200)

      const { params } = await response.json()

      expect(params).toMatchObject({ catchall: ['html'] })
    })

    test('should NOT match on non-localized excluded page path', async ({
      middlewareI18nExcludedPaths,
    }) => {
      const response = await fetch(`${middlewareI18nExcludedPaths.url}/excluded`)

      expect(response.headers.get('x-test-used-middleware')).not.toBe('true')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/text\/html/)

      const html = await response.text()
      const { locale, params } = extractDataFromHtml(html)

      expect(params).toMatchObject({ catchall: ['excluded'] })
      expect(locale).toBe(DEFAULT_LOCALE)
    })

    test('should NOT match on localized excluded page path', async ({
      middlewareI18nExcludedPaths,
    }) => {
      const response = await fetch(`${middlewareI18nExcludedPaths.url}/fr/excluded`)

      expect(response.headers.get('x-test-used-middleware')).not.toBe('true')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/text\/html/)

      const html = await response.text()
      const { locale, params } = extractDataFromHtml(html)

      expect(params).toMatchObject({ catchall: ['excluded'] })
      expect(locale).toBe('fr')
    })
  })
})

test("requests with x-middleware-subrequest don't skip middleware (GHSA-f82v-jwr5-mffw)", async ({
  middlewareSubrequestVuln,
}) => {
  const response = await fetch(`${middlewareSubrequestVuln.url}`, {
    headers: {
      'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware',
    },
  })

  // middleware was not skipped
  expect(response.headers.get('x-test-used-middleware')).toBe('true')

  // ensure we are testing version before the fix for self hosted
  expect(response.headers.get('x-test-used-next-version')).toBe('15.2.2')
})

test('requests with different encoding than matcher match anyway', async ({
  middlewareStaticAssetMatcher,
}) => {
  const response = await fetch(`${middlewareStaticAssetMatcher.url}/hello%2Fworld.txt`)

  // middleware was not skipped
  expect(await response.text()).toBe('hello from middleware')
})

test.describe('RSC cache poisoning', () => {
  test('Middleware rewrite', async ({ page, middleware }) => {
    const prefetchResponsePromise = new Promise<Response>((resolve) => {
      page.on('response', (response) => {
        if (
          (response.url().includes('/test/rewrite-to-cached-page') ||
            response.url().includes('/caching-rewrite-target')) &&
          response.status() === 200
        ) {
          resolve(response)
        }
      })
    })
    await page.goto(`${middleware.url}/link-to-rewrite-to-cached-page`)

    // ensure prefetch
    await page.hover('text=NextResponse.rewrite')

    // wait for prefetch request to finish
    const prefetchResponse = await prefetchResponsePromise

    // ensure prefetch respond with RSC data
    expect(prefetchResponse.headers()['content-type']).toMatch(/text\/x-component/)
    expect(prefetchResponse.headers()['netlify-cdn-cache-control']).toMatch(/s-maxage=31536000/)

    const htmlResponse = await page.goto(`${middleware.url}/test/rewrite-to-cached-page`)

    // ensure we get HTML response
    expect(htmlResponse?.headers()['content-type']).toMatch(/text\/html/)
    expect(htmlResponse?.headers()['netlify-cdn-cache-control']).toMatch(/s-maxage=31536000/)
  })

  test('Middleware redirect', async ({ page, middleware }) => {
    const prefetchResponsePromise = new Promise<Response>((resolve) => {
      page.on('response', (response) => {
        if (response.url().includes('/caching-redirect-target') && response.status() === 200) {
          resolve(response)
        }
      })
    })
    await page.goto(`${middleware.url}/link-to-redirect-to-cached-page`)

    // ensure prefetch
    await page.hover('text=NextResponse.redirect')

    // wait for prefetch request to finish
    const prefetchResponse = await prefetchResponsePromise

    // ensure prefetch respond with RSC data
    expect(prefetchResponse.headers()['content-type']).toMatch(/text\/x-component/)
    expect(prefetchResponse.headers()['netlify-cdn-cache-control']).toMatch(/s-maxage=31536000/)

    const htmlResponse = await page.goto(`${middleware.url}/test/redirect-to-cached-page`)

    // ensure we get HTML response
    expect(htmlResponse?.headers()['content-type']).toMatch(/text\/html/)
    expect(htmlResponse?.headers()['netlify-cdn-cache-control']).toMatch(/s-maxage=31536000/)
  })
})
