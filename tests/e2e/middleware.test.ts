import { expect, Response } from '@playwright/test'
import { hasNodeMiddlewareSupport, nextVersionSatisfies } from '../utils/next-version-helpers.mjs'
import { test as baseTest } from '../utils/playwright-helpers.js'
import { getImageSize } from 'next/dist/server/image-optimizer.js'
import type { Fixture } from '../utils/create-e2e-fixture.js'

type ExtendedWindow = Window & {
  didReload?: boolean
}

type ExtendedFixtures = {
  edgeOrNodeMiddleware: Fixture
  edgeOrNodeMiddlewarePages: Fixture
  edgeOrNodeMiddlewareI18n: Fixture
  edgeOrNodeMiddlewareI18nExcludedPaths: Fixture
  edgeOrNodeMiddlewareStaticAssetMatcher: Fixture
}

for (const { expectedRuntime, isNodeMiddleware, label, testWithSwitchableMiddlewareRuntime } of [
  {
    expectedRuntime: 'edge-runtime',
    isNodeMiddleware: false,
    label: 'Edge runtime middleware',
    testWithSwitchableMiddlewareRuntime: baseTest.extend<{}, ExtendedFixtures>({
      edgeOrNodeMiddleware: [
        async ({ middleware }, use) => {
          await use(middleware)
        },
        {
          scope: 'worker',
        },
      ],
      edgeOrNodeMiddlewarePages: [
        async ({ middlewarePages }, use) => {
          await use(middlewarePages)
        },
        {
          scope: 'worker',
        },
      ],
      edgeOrNodeMiddlewareI18n: [
        async ({ middlewareI18n }, use) => {
          await use(middlewareI18n)
        },
        {
          scope: 'worker',
        },
      ],
      edgeOrNodeMiddlewareI18nExcludedPaths: [
        async ({ middlewareI18nExcludedPaths }, use) => {
          await use(middlewareI18nExcludedPaths)
        },
        {
          scope: 'worker',
        },
      ],
      edgeOrNodeMiddlewareStaticAssetMatcher: [
        async ({ middlewareStaticAssetMatcher }, use) => {
          await use(middlewareStaticAssetMatcher)
        },
        {
          scope: 'worker',
        },
      ],
    }),
  },
  hasNodeMiddlewareSupport()
    ? {
        expectedRuntime: 'node',
        isNodeMiddleware: true,
        label: 'Node.js runtime middleware',
        testWithSwitchableMiddlewareRuntime: baseTest.extend<{}, ExtendedFixtures>({
          edgeOrNodeMiddleware: [
            async ({ middlewareNode }, use) => {
              await use(middlewareNode)
            },
            {
              scope: 'worker',
            },
          ],
          edgeOrNodeMiddlewarePages: [
            async ({ middlewarePagesNode }, use) => {
              await use(middlewarePagesNode)
            },
            {
              scope: 'worker',
            },
          ],
          edgeOrNodeMiddlewareI18n: [
            async ({ middlewareI18nNode }, use) => {
              await use(middlewareI18nNode)
            },
            {
              scope: 'worker',
            },
          ],
          edgeOrNodeMiddlewareI18nExcludedPaths: [
            async ({ middlewareI18nExcludedPathsNode }, use) => {
              await use(middlewareI18nExcludedPathsNode)
            },
            {
              scope: 'worker',
            },
          ],
          edgeOrNodeMiddlewareStaticAssetMatcher: [
            async ({ middlewareStaticAssetMatcherNode }, use) => {
              await use(middlewareStaticAssetMatcherNode)
            },
            {
              scope: 'worker',
            },
          ],
        }),
      }
    : undefined,
].filter(function isDefined<T>(argument: T | undefined): argument is T {
  return typeof argument !== 'undefined'
})) {
  // TODO(adapter): don't skip once we look into middleware handling
  const test = process.env.NETLIFY_NEXT_EXPERIMENTAL_ADAPTER
    ? testWithSwitchableMiddlewareRuntime.skip
    : testWithSwitchableMiddlewareRuntime
  const testDescribe = process.env.NETLIFY_NEXT_EXPERIMENTAL_ADAPTER
    ? testWithSwitchableMiddlewareRuntime.describe.skip
    : testWithSwitchableMiddlewareRuntime.describe

  testDescribe(label, () => {
    test('Runs middleware', async ({ page, edgeOrNodeMiddleware }) => {
      const res = await page.goto(`${edgeOrNodeMiddleware.url}/test/redirect`)

      await expect(page).toHaveTitle('Simple Next App')

      const h1 = page.locator('h1')
      await expect(h1).toHaveText('Other')
    })

    test('Does not run middleware at the origin', async ({ page, edgeOrNodeMiddleware }) => {
      const res = await page.goto(`${edgeOrNodeMiddleware.url}/test/next`)

      expect(await res?.headerValue('x-deno')).toBeTruthy()
      expect(await res?.headerValue('x-node')).toBeNull()

      await expect(page).toHaveTitle('Simple Next App')

      const h1 = page.locator('h1')
      await expect(h1).toHaveText('Message from middleware: hello')

      expect(await res?.headerValue('x-runtime')).toEqual(expectedRuntime)
    })

    test('does not run middleware again for rewrite target', async ({
      page,
      edgeOrNodeMiddleware,
    }) => {
      const direct = await page.goto(`${edgeOrNodeMiddleware.url}/test/rewrite-target`)
      expect(await direct?.headerValue('x-added-rewrite-target')).toBeTruthy()

      const rewritten = await page.goto(`${edgeOrNodeMiddleware.url}/test/rewrite-loop-detect`)

      expect(await rewritten?.headerValue('x-added-rewrite-target')).toBeNull()
      const h1 = page.locator('h1')
      await expect(h1).toHaveText('Hello rewrite')

      expect(await direct?.headerValue('x-runtime')).toEqual(expectedRuntime)
    })

    test('Supports CJS dependencies in Edge Middleware', async ({ page, edgeOrNodeMiddleware }) => {
      const res = await page.goto(`${edgeOrNodeMiddleware.url}/test/next`)

      expect(await res?.headerValue('x-cjs-module-works')).toEqual('true')
      expect(await res?.headerValue('x-runtime')).toEqual(expectedRuntime)
    })

    if (expectedRuntime !== 'node' && nextVersionSatisfies('>=14.0.0')) {
      // adaptation of https://github.com/vercel/next.js/blob/8aa9a52c36f338320d55bd2ec292ffb0b8c7cb35/test/e2e/app-dir/metadata-edge/index.test.ts#L24C5-L31C7
      test('it should render OpenGraph image meta tag correctly', async ({
        page,
        middlewareOg,
      }) => {
        await page.goto(`${middlewareOg.url}/`)
        const ogURL = await page.locator('meta[property="og:image"]').getAttribute('content')
        expect(ogURL).toBeTruthy()
        const ogResponse = await fetch(new URL(new URL(ogURL!).pathname, middlewareOg.url))
        const imageBuffer = await ogResponse.arrayBuffer()
        const size = await getImageSize(Buffer.from(imageBuffer), 'png')
        expect([size.width, size.height]).toEqual([1200, 630])
      })
    }

    testDescribe('json data', () => {
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

      testDescribe('no 18n', () => {
        for (const testConfig of testConfigs) {
          testDescribe(testConfig.describeLabel, () => {
            test('json data fetch', async ({ edgeOrNodeMiddlewarePages, page }) => {
              const dataFetchPromise = new Promise<Response>((resolve) => {
                page.on('response', (response) => {
                  if (response.url().includes(testConfig.jsonPathMatcher)) {
                    resolve(response)
                  }
                })
              })

              const pageResponse = await page.goto(`${edgeOrNodeMiddlewarePages.url}/link`)
              expect(await pageResponse?.headerValue('x-runtime')).toEqual(expectedRuntime)

              await page.hover(`[data-link="${testConfig.selector}"]`)

              const dataResponse = await dataFetchPromise

              expect(dataResponse.ok()).toBe(true)
            })

            test('navigation', async ({ edgeOrNodeMiddlewarePages, page }) => {
              const pageResponse = await page.goto(`${edgeOrNodeMiddlewarePages.url}/link`)
              expect(await pageResponse?.headerValue('x-runtime')).toEqual(expectedRuntime)

              // wait for hydration to finish before doing client navigation
              await expect(page.getByTestId('hydration')).toHaveText('hydrated', {
                timeout: 10_000,
              })

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

      testDescribe('with 18n', () => {
        for (const testConfig of testConfigs) {
          testDescribe(testConfig.describeLabel, () => {
            for (const { localeLabel, pageWithLinksPathname } of [
              { localeLabel: 'implicit default locale', pageWithLinksPathname: '/link' },
              { localeLabel: 'explicit default locale', pageWithLinksPathname: '/en/link' },
              { localeLabel: 'explicit non-default locale', pageWithLinksPathname: '/fr/link' },
            ]) {
              testDescribe(localeLabel, () => {
                test('json data fetch', async ({ edgeOrNodeMiddlewareI18n, page }) => {
                  const dataFetchPromise = new Promise<Response>((resolve) => {
                    page.on('response', (response) => {
                      if (response.url().includes(testConfig.jsonPathMatcher)) {
                        resolve(response)
                      }
                    })
                  })

                  const pageResponse = await page.goto(
                    `${edgeOrNodeMiddlewareI18n.url}${pageWithLinksPathname}`,
                  )
                  expect(await pageResponse?.headerValue('x-runtime')).toEqual(expectedRuntime)

                  await page.hover(`[data-link="${testConfig.selector}"]`)

                  const dataResponse = await dataFetchPromise

                  expect(dataResponse.ok()).toBe(true)
                })

                test('navigation', async ({ edgeOrNodeMiddlewareI18n, page }) => {
                  const pageResponse = await page.goto(
                    `${edgeOrNodeMiddlewareI18n.url}${pageWithLinksPathname}`,
                  )
                  expect(await pageResponse?.headerValue('x-runtime')).toEqual(expectedRuntime)

                  // wait for hydration to finish before doing client navigation
                  await expect(page.getByTestId('hydration')).toHaveText('hydrated', {
                    timeout: 10_000,
                  })

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
    testDescribe('Middleware with i18n and excluded paths', () => {
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
      testDescribe('Middleware response path', () => {
        test('should match on non-localized not excluded page path', async ({
          edgeOrNodeMiddlewareI18nExcludedPaths,
        }) => {
          const response = await fetch(`${edgeOrNodeMiddlewareI18nExcludedPaths.url}/json`)

          expect(response.headers.get('x-test-used-middleware')).toBe('true')
          expect(response.headers.get('x-runtime')).toEqual(expectedRuntime)
          expect(response.status).toBe(200)

          const { nextUrlPathname, nextUrlLocale } = await response.json()

          expect(nextUrlPathname).toBe('/json')
          expect(nextUrlLocale).toBe(DEFAULT_LOCALE)
        })

        test('should match on localized not excluded page path', async ({
          edgeOrNodeMiddlewareI18nExcludedPaths,
        }) => {
          const response = await fetch(`${edgeOrNodeMiddlewareI18nExcludedPaths.url}/fr/json`)

          expect(response.headers.get('x-test-used-middleware')).toBe('true')
          expect(response.headers.get('x-runtime')).toEqual(expectedRuntime)
          expect(response.status).toBe(200)

          const { nextUrlPathname, nextUrlLocale } = await response.json()

          expect(nextUrlPathname).toBe('/json')
          expect(nextUrlLocale).toBe('fr')
        })
      })

      // those tests hit paths that don't end with `/json` while still satisfying middleware matcher
      // so middleware should pass them through to origin
      testDescribe('Middleware passthrough', () => {
        test('should match on non-localized not excluded page path', async ({
          edgeOrNodeMiddlewareI18nExcludedPaths,
        }) => {
          const response = await fetch(`${edgeOrNodeMiddlewareI18nExcludedPaths.url}/html`)

          expect(response.headers.get('x-test-used-middleware')).toBe('true')
          expect(response.headers.get('x-runtime')).toEqual(expectedRuntime)
          expect(response.status).toBe(200)
          expect(response.headers.get('content-type')).toMatch(/text\/html/)

          const html = await response.text()
          const { locale, params } = extractDataFromHtml(html)

          expect(params).toMatchObject({ catchall: ['html'] })
          expect(locale).toBe(DEFAULT_LOCALE)
        })

        test('should match on localized not excluded page path', async ({
          edgeOrNodeMiddlewareI18nExcludedPaths,
        }) => {
          const response = await fetch(`${edgeOrNodeMiddlewareI18nExcludedPaths.url}/fr/html`)

          expect(response.headers.get('x-test-used-middleware')).toBe('true')
          expect(response.headers.get('x-runtime')).toEqual(expectedRuntime)
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
      testDescribe('Middleware skipping (paths not satisfying middleware matcher)', () => {
        test('should NOT match on non-localized excluded API path', async ({
          edgeOrNodeMiddlewareI18nExcludedPaths,
        }) => {
          const response = await fetch(`${edgeOrNodeMiddlewareI18nExcludedPaths.url}/api/html`)

          expect(response.headers.get('x-test-used-middleware')).not.toBe('true')
          expect(response.status).toBe(200)

          const { params } = await response.json()

          expect(params).toMatchObject({ catchall: ['html'] })
        })

        test('should NOT match on non-localized excluded page path', async ({
          edgeOrNodeMiddlewareI18nExcludedPaths,
        }) => {
          const response = await fetch(`${edgeOrNodeMiddlewareI18nExcludedPaths.url}/excluded`)

          expect(response.headers.get('x-test-used-middleware')).not.toBe('true')
          expect(response.status).toBe(200)
          expect(response.headers.get('content-type')).toMatch(/text\/html/)

          const html = await response.text()
          const { locale, params } = extractDataFromHtml(html)

          expect(params).toMatchObject({ catchall: ['excluded'] })
          expect(locale).toBe(DEFAULT_LOCALE)
        })

        test('should NOT match on localized excluded page path', async ({
          edgeOrNodeMiddlewareI18nExcludedPaths,
        }) => {
          const response = await fetch(`${edgeOrNodeMiddlewareI18nExcludedPaths.url}/fr/excluded`)

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

    test('requests with different encoding than matcher match anyway', async ({
      edgeOrNodeMiddlewareStaticAssetMatcher,
    }) => {
      const response = await fetch(
        `${edgeOrNodeMiddlewareStaticAssetMatcher.url}/hello%2Fworld.txt`,
      )

      // middleware was not skipped
      expect(await response.text()).toBe('hello from middleware')
      expect(response.headers.get('x-runtime')).toEqual(expectedRuntime)
    })

    testDescribe('RSC cache poisoning', () => {
      test('Middleware rewrite', async ({ page, edgeOrNodeMiddleware }) => {
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
        await page.goto(`${edgeOrNodeMiddleware.url}/link-to-rewrite-to-cached-page`)

        // ensure prefetch
        await page.hover('text=NextResponse.rewrite')

        // wait for prefetch request to finish
        const prefetchResponse = await prefetchResponsePromise

        // ensure prefetch respond with RSC data
        expect(prefetchResponse.headers()['content-type']).toMatch(/text\/x-component/)
        expect(prefetchResponse.headers()['debug-netlify-cdn-cache-control']).toMatch(
          /(max-age|s-maxage)=31536000/,
        )

        const htmlResponse = await page.goto(
          `${edgeOrNodeMiddleware.url}/test/rewrite-to-cached-page`,
        )

        // ensure we get HTML response
        expect(htmlResponse?.headers()['content-type']).toMatch(/text\/html/)
        expect(htmlResponse?.headers()['debug-netlify-cdn-cache-control']).toMatch(
          /(max-age|s-maxage)=31536000/,
        )
      })

      test('Middleware redirect', async ({ page, edgeOrNodeMiddleware }) => {
        const prefetchResponsePromise = new Promise<Response>((resolve) => {
          page.on('response', (response) => {
            if (response.url().includes('/caching-redirect-target') && response.status() === 200) {
              resolve(response)
            }
          })
        })
        await page.goto(`${edgeOrNodeMiddleware.url}/link-to-redirect-to-cached-page`)

        // ensure prefetch
        await page.hover('text=NextResponse.redirect')

        // wait for prefetch request to finish
        const prefetchResponse = await prefetchResponsePromise

        // ensure prefetch respond with RSC data
        expect(prefetchResponse.headers()['content-type']).toMatch(/text\/x-component/)
        expect(prefetchResponse.headers()['debug-netlify-cdn-cache-control']).toMatch(
          /(max-age|s-maxage)=31536000/,
        )

        const htmlResponse = await page.goto(
          `${edgeOrNodeMiddleware.url}/test/redirect-to-cached-page`,
        )

        // ensure we get HTML response
        expect(htmlResponse?.headers()['content-type']).toMatch(/text\/html/)
        expect(htmlResponse?.headers()['debug-netlify-cdn-cache-control']).toMatch(
          /(max-age|s-maxage)=31536000/,
        )
      })
    })

    if (isNodeMiddleware) {
      // Node.js Middleware specific tests to test features not available in Edge Runtime
      testDescribe('Node.js Middleware specific', () => {
        testDescribe('npm package manager', () => {
          test('node:crypto module', async ({ middlewareNodeRuntimeSpecific }) => {
            const response = await fetch(`${middlewareNodeRuntimeSpecific.url}/test/crypto`)
            expect(response.status).toBe(200)
            const body = await response.json()
            expect(
              body.random,
              'random should have 16 random bytes generated with `randomBytes` function from node:crypto in hex format',
            ).toMatch(/[0-9a-f]{32}/)
          })

          test('node:http(s) module', async ({ middlewareNodeRuntimeSpecific }) => {
            const response = await fetch(`${middlewareNodeRuntimeSpecific.url}/test/http`)
            expect(response.status).toBe(200)
            const body = await response.json()
            expect(
              body.proxiedWithHttpRequest,
              'proxiedWithHttpRequest should be the result of `http.request` from node:http fetching static asset',
            ).toStrictEqual({ hello: 'world' })
          })

          test('node:path module', async ({ middlewareNodeRuntimeSpecific }) => {
            const response = await fetch(`${middlewareNodeRuntimeSpecific.url}/test/path`)
            expect(response.status).toBe(200)
            const body = await response.json()
            expect(
              body.joined,
              'joined should be the result of `join` function from node:path',
            ).toBe('a/b')
          })
        })

        testDescribe('pnpm package manager', () => {
          test('node:crypto module', async ({ middlewareNodeRuntimeSpecificPnpm }) => {
            const response = await fetch(`${middlewareNodeRuntimeSpecificPnpm.url}/test/crypto`)
            expect(response.status).toBe(200)
            const body = await response.json()
            expect(
              body.random,
              'random should have 16 random bytes generated with `randomBytes` function from node:crypto in hex format',
            ).toMatch(/[0-9a-f]{32}/)
          })

          test('node:http(s) module', async ({ middlewareNodeRuntimeSpecificPnpm }) => {
            const response = await fetch(`${middlewareNodeRuntimeSpecificPnpm.url}/test/http`)
            expect(response.status).toBe(200)
            const body = await response.json()
            expect(
              body.proxiedWithHttpRequest,
              'proxiedWithHttpRequest should be the result of `http.request` from node:http fetching static asset',
            ).toStrictEqual({ hello: 'world' })
          })

          test('node:path module', async ({ middlewareNodeRuntimeSpecificPnpm }) => {
            const response = await fetch(`${middlewareNodeRuntimeSpecificPnpm.url}/test/path`)
            expect(response.status).toBe(200)
            const body = await response.json()
            expect(
              body.joined,
              'joined should be the result of `join` function from node:path',
            ).toBe('a/b')
          })
        })
      })
    }
  })
}

// TODO(adapter): don't skip once we look into middleware handling
const adapterBaseTest = process.env.NETLIFY_NEXT_EXPERIMENTAL_ADAPTER ? baseTest.skip : baseTest

// this test is using pinned next version that doesn't support node middleware
adapterBaseTest(
  "requests with x-middleware-subrequest don't skip middleware (GHSA-f82v-jwr5-mffw)",
  async ({ middlewareSubrequestVuln }) => {
    const response = await fetch(`${middlewareSubrequestVuln.url}`, {
      headers: {
        'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware',
      },
    })

    // middleware was not skipped
    expect(response.headers.get('x-test-used-middleware')).toBe('true')

    // ensure we are testing version before the fix for self hosted
    expect(response.headers.get('x-test-used-next-version')).toBe('15.1.11')
  },
)
