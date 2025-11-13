import { expect } from '@playwright/test'
import { execaCommand } from 'execa'
import {
  createE2EFixture,
  createSite,
  deleteSite,
  getBuildFixtureVariantCommand,
  publishDeploy,
} from '../utils/create-e2e-fixture.js'
import { test as baseTest } from '../utils/playwright-helpers.js'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'

type ExtendedFixtures = {
  skewProtection: {
    siteId: string
    url: string
    deployA: Awaited<ReturnType<typeof createE2EFixture>>
    deployB: Awaited<ReturnType<typeof createE2EFixture>>
  }
}

const test = baseTest.extend<
  { prepareSkewProtectionScenario: <T>(callback: () => T) => Promise<T> },
  ExtendedFixtures
>({
  prepareSkewProtectionScenario: async ({ skewProtection }, use) => {
    const fixture = async <T>(callback: () => T) => {
      // first we will publish deployA
      // then we call arbitrary callback to allow tests to load page using deployA
      // and after that we will publish deployB so page loaded in browser is not using
      // currently published deploy anymore, but still get results from initially published deploy

      const pollURL = `${skewProtection.url}/variant.txt`

      await publishDeploy(skewProtection.siteId, skewProtection.deployA.deployID)

      // poll to ensure deploy was restored before continuing
      while (true) {
        const response = await fetch(pollURL)
        const text = await response.text()
        if (text.startsWith('A')) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const result = await callback()

      await publishDeploy(skewProtection.siteId, skewProtection.deployB.deployID)

      // https://netlify.slack.com/archives/C098NQ4DEF6/p1758207235732189
      await new Promise((resolve) => setTimeout(resolve, 3000))

      // poll to ensure deploy was restored before continuing
      while (true) {
        const response = await fetch(pollURL)
        const text = await response.text()
        if (text.startsWith('B')) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      return result
    }

    await use(fixture)
  },
  skewProtection: [
    async ({}, use) => {
      const { siteId, url } = await createSite({
        name: `next-skew-tests-${Date.now()}`,
      })

      const deployAPromise = createE2EFixture('skew-protection', {
        siteId,
        env: {
          NETLIFY_NEXT_SKEW_PROTECTION: 'true',
        },
      })

      const deployBPromise = createE2EFixture('skew-protection', {
        siteId,
        env: {
          NETLIFY_NEXT_SKEW_PROTECTION: 'true',
        },
        onPreDeploy: async (fixtureRoot) => {
          await execaCommand(
            `${getBuildFixtureVariantCommand('variant-b')} --apply-file-changes-only`,
            {
              cwd: fixtureRoot,
            },
          )
        },
      })

      const [deployA, deployB] = await Promise.all([deployAPromise, deployBPromise])

      const fixture = {
        url,
        siteId,
        deployA,
        deployB,

        cleanup: async () => {
          if (process.env.E2E_PERSIST) {
            console.log(
              `💾 Fixture and deployed site have been persisted. To clean up automatically, run tests without the 'E2E_PERSIST' environment variable.`,
            )

            return
          }

          await deployA.cleanup()
          await deployB.cleanup()
          await deleteSite(siteId)
        },
      }

      // for local iteration - this will print out snippet to allow to reuse previously deployed setup
      // paste this at the top of `skewProtection` fixture function and this will avoid having to wait for redeploys
      // keep in mind that if fixture itself require changes, you will have to redeploy
      // uncomment console.log if you want to use same site/fixture and just iterate on test themselves
      // and run a test with E2E_PERSIST=1 to keep site around for future runs
      if (process.env.E2E_PERSIST) {
        console.log(
          'You can reuse persisted site by pasting below snippet at the top of `skewProtection` fixture logic',
        )
        console.log(`await use(${JSON.stringify(fixture, null, 2)})\n\nreturn`)
      }
      await use(fixture)

      await fixture.cleanup()
    },
    {
      scope: 'worker',
    },
  ],
})

test.describe('Skew Protection', () => {
  test.describe('App Router', () => {
    test('should scope next/link navigation to initial deploy', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      test.skip(
        !nextVersionSatisfies('>=15.0.0'),
        'next/link navigation scoped to initial deploy is only supported in Next.js >=15.0.0',
      )

      // this tests that both RSC and browser .js bundles for linked route are scoped to initial deploy
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/app-router`)
      })

      // now that other deploy was published, we can show links
      page.getByTestId('next-link-expand-button').click()

      // wait for links to show
      const element = await page.waitForSelector('[data-testid="next-link-linked-page"]')
      element.click()

      // ensure expected version of a page is rendered
      await expect(page.getByTestId('linked-page-server-component-current-variant')).toHaveText(
        '"A"',
      )
      await expect(page.getByTestId('linked-page-client-component-current-variant')).toHaveText(
        '"A"',
      )
    })

    test('should scope server actions to initial deploy', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/app-router`)
      })

      page.getByTestId('server-action-button').click()

      const element = await page.waitForSelector('[data-testid="server-action-result"]')
      const content = await element.textContent()

      // if skew protection does not work, this will be either "B" (currently published deploy)
      // or error about not finding server action - example of such error:
      // "Error: Server Action "00a130b1673301d79679b22abb06a62c3125376d79" was not found on the server.
      // Read more: https://nextjs.org/docs/messages/failed-to-find-server-action"
      expect(content).toBe(`"A"`)
    })

    test('should scope route handler to initial deploy when manual fetch have X-Deployment-Id request header', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/app-router`)
      })

      page.getByTestId('scoped-route-handler-button').click()

      const element = await page.waitForSelector('[data-testid="scoped-route-handler-result"]')
      const content = await element.textContent()

      // if skew protection does not work, this will be "B" (currently published deploy)
      expect(content).toBe(`"A"`)
    })

    test('should NOT scope route handler to initial deploy when manual fetch does NOT have X-Deployment-Id request header', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      // this test doesn't really test skew protection, because in this scenario skew protection is not expected to kick in
      // it's added here mostly to document this interaction
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/app-router`)
      })

      page.getByTestId('unscoped-route-handler-button').click()

      const element = await page.waitForSelector('[data-testid="unscoped-route-handler-result"]')
      const content = await element.textContent()

      // when fetch in not scoped, it will use currently published deploy, so "B" is expected
      expect(content).toBe(`"B"`)
    })
  })

  test.describe('Pages Router', () => {
    test.describe('should scope next/link navigation to initial deploy', () => {
      test('when linked page is fully static', async ({
        page,
        skewProtection,
        prepareSkewProtectionScenario,
      }) => {
        test.skip(
          !nextVersionSatisfies('>=15.0.0'),
          'next/link navigation scoped to initial deploy is only supported in Next.js >=15.0.0',
        )
        // this tests that browser .js bundles for linked route are scoped to initial deploy (fully static pages don't have page-data json)
        await prepareSkewProtectionScenario(async () => {
          return await page.goto(`${skewProtection.url}/pages-router`)
        })

        // now that other deploy was published, we can show links
        page.getByTestId('next-link-expand-button').click()

        // wait for links to show
        const element = await page.waitForSelector('[data-testid="next-link-fully-static"]')
        element.click()

        // ensure expected version of a page is rendered
        await expect(page.getByTestId('linked-static-current-variant')).toHaveText('"A"')
      })

      test('when linked page is getStaticProps page', async ({
        page,
        skewProtection,
        prepareSkewProtectionScenario,
      }) => {
        test.skip(
          !nextVersionSatisfies('>=15.0.0'),
          'next/link navigation scoped to initial deploy is only supported in Next.js >=15.0.0',
        )
        // this tests that both json page data and browser .js bundles for linked route are scoped to initial deploy
        await prepareSkewProtectionScenario(async () => {
          return await page.goto(`${skewProtection.url}/pages-router`)
        })

        // now that other deploy was published, we can show links
        page.getByTestId('next-link-expand-button').click()

        // wait for links to show
        const element = await page.waitForSelector('[data-testid="next-link-getStaticProps"]')
        element.click()

        // ensure expected version of a page is rendered
        await expect(page.getByTestId('linked-getStaticProps-current-variant')).toHaveText('"A"')
        await expect(page.getByTestId('linked-getStaticProps-props-variant')).toHaveText('"A"')
      })

      test('when linked page is getServerSideProps page', async ({
        page,
        skewProtection,
        prepareSkewProtectionScenario,
      }) => {
        test.skip(
          !nextVersionSatisfies('>=15.0.0'),
          'next/link navigation scoped to initial deploy is only supported in Next.js >=15.0.0',
        )
        // this tests that both json page data and browser .js bundles for linked route are scoped to initial deploy
        await prepareSkewProtectionScenario(async () => {
          return await page.goto(`${skewProtection.url}/pages-router`)
        })

        // now that other deploy was published, we can show links
        page.getByTestId('next-link-expand-button').click()

        // wait for links to show
        const element = await page.waitForSelector('[data-testid="next-link-getServerSideProps"]')
        element.click()

        // ensure expected version of a page is rendered
        await expect(page.getByTestId('linked-getServerSideProps-current-variant')).toHaveText(
          '"A"',
        )
        await expect(page.getByTestId('linked-getServerSideProps-props-variant')).toHaveText('"A"')
      })
    })

    test('should scope api route to initial deploy when manual fetch have X-Deployment-Id request header', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/pages-router`)
      })

      page.getByTestId('scoped-api-route-button').click()

      const element = await page.waitForSelector('[data-testid="scoped-api-route-result"]')
      const content = await element.textContent()

      // if skew protection does not work, this will be "B" (currently published deploy)
      expect(content).toBe(`"A"`)
    })

    test('should NOT scope api route to initial deploy when manual fetch does NOT have X-Deployment-Id request header', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      // this test doesn't really test skew protection, because in this scenario skew protection is not expected to kick in
      // it's added here mostly to document this interaction
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/pages-router`)
      })

      page.getByTestId('unscoped-api-route-button').click()

      const element = await page.waitForSelector('[data-testid="unscoped-api-route-result"]')
      const content = await element.textContent()

      // when fetch in not scoped, it will use currently published deploy, so "B" is expected
      expect(content).toBe(`"B"`)
    })
  })

  test.describe('Middleware', () => {
    test.describe('should scope next/link navigation to initial deploy', () => {
      test('NextResponse.next()', async ({
        page,
        skewProtection,
        prepareSkewProtectionScenario,
      }) => {
        test.skip(
          !nextVersionSatisfies('>=15.0.0'),
          'next/link navigation scoped to initial deploy is only supported in Next.js >=15.0.0',
        )
        // this tests that browser .js bundles for linked route are scoped to initial deploy (fully static pages don't have page-data json)
        await prepareSkewProtectionScenario(async () => {
          return await page.goto(`${skewProtection.url}/middleware`)
        })

        // now that other deploy was published, we can show links
        page.getByTestId('next-link-expand-button').click()

        // wait for links to show
        const element = await page.waitForSelector(
          '[data-testid="next-link-linked-page-middleware-next"]',
        )
        element.click()

        // ensure expected version of a page is rendered
        await expect(page.getByTestId('linked-page-current-variant')).toHaveText('"A"')
        await expect(page.getByTestId('linked-page-slug')).toHaveText('next')
      })

      test('NextResponse.redirect()', async ({
        page,
        skewProtection,
        prepareSkewProtectionScenario,
      }) => {
        test.skip(
          !nextVersionSatisfies('>=15.0.0'),
          'next/link navigation scoped to initial deploy is only supported in Next.js >=15.0.0',
        )
        // this tests that browser .js bundles for linked route are scoped to initial deploy (fully static pages don't have page-data json)
        await prepareSkewProtectionScenario(async () => {
          return await page.goto(`${skewProtection.url}/middleware`)
        })

        // now that other deploy was published, we can show links
        page.getByTestId('next-link-expand-button').click()

        // wait for links to show
        const element = await page.waitForSelector(
          '[data-testid="next-link-linked-page-middleware-redirect"]',
        )
        element.click()

        // ensure expected version of a page is rendered
        await expect(page.getByTestId('linked-page-current-variant')).toHaveText('"A"')
        await expect(page.getByTestId('linked-page-slug')).toHaveText('redirect-a')
      })

      test('NextResponse.rewrite()', async ({
        page,
        skewProtection,
        prepareSkewProtectionScenario,
      }) => {
        test.skip(
          !nextVersionSatisfies('>=15.0.0'),
          'next/link navigation scoped to initial deploy is only supported in Next.js >=15.0.0',
        )
        // this tests that browser .js bundles for linked route are scoped to initial deploy (fully static pages don't have page-data json)
        await prepareSkewProtectionScenario(async () => {
          return await page.goto(`${skewProtection.url}/middleware`)
        })

        // now that other deploy was published, we can show links
        page.getByTestId('next-link-expand-button').click()

        // wait for links to show
        const element = await page.waitForSelector(
          '[data-testid="next-link-linked-page-middleware-rewrite"]',
        )
        element.click()

        // ensure expected version of a page is rendered
        await expect(page.getByTestId('linked-page-current-variant')).toHaveText('"A"')
        await expect(page.getByTestId('linked-page-slug')).toHaveText('rewrite-a')
      })
    })

    test('should scope middleware endpoint to initial deploy when manual fetch have X-Deployment-Id request header', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/middleware`)
      })

      page.getByTestId('scoped-middleware-endpoint-button').click()

      const element = await page.waitForSelector(
        '[data-testid="scoped-middleware-endpoint-result"]',
      )
      const content = await element.textContent()

      // if skew protection does not work, this will be "B" (currently published deploy)
      expect(content).toBe(`"A"`)
    })

    test('should NOT scope middleware endpoint to initial deploy when manual fetch does NOT have X-Deployment-Id request header', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      // this test doesn't really test skew protection, because in this scenario skew protection is not expected to kick in
      // it's added here mostly to document this interaction
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/middleware`)
      })

      page.getByTestId('unscoped-middleware-endpoint-button').click()

      const element = await page.waitForSelector(
        '[data-testid="unscoped-middleware-endpoint-result"]',
      )
      const content = await element.textContent()

      // when fetch in not scoped, it will use currently published deploy, so "B" is expected
      expect(content).toBe(`"B"`)
    })
  })

  test.describe('Next.js config rewrite and redirects', () => {
    test('should scope next/link navigation to initial deploy when link target is Next.js config redirect', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      test.skip(
        !nextVersionSatisfies('>=15.0.0'),
        'next/link navigation scoped to initial deploy is only supported in Next.js >=15.0.0',
      )
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/next-config`)
      })

      // now that other deploy was published, we can show links
      page.getByTestId('next-link-expand-button').click()

      // wait for links to show
      const element = await page.waitForSelector(
        '[data-testid="next-link-linked-page-next-config-redirect"]',
      )
      element.click()

      // ensure expected version of a page is rendered
      await expect(page.getByTestId('linked-page-current-variant')).toHaveText('"A"')
      await expect(page.getByTestId('linked-page-slug')).toHaveText('redirect-a')
    })

    test('should scope next/link navigation to initial deploy when link target is Next.js config rewrite', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      test.skip(
        !nextVersionSatisfies('>=15.0.0'),
        'next/link navigation scoped to initial deploy is only supported in Next.js >=15.0.0',
      )
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/next-config`)
      })

      // now that other deploy was published, we can show links
      page.getByTestId('next-link-expand-button').click()

      // wait for links to show
      const element = await page.waitForSelector(
        '[data-testid="next-link-linked-page-next-config-rewrite"]',
      )
      element.click()

      // ensure expected version of a page is rendered
      await expect(page.getByTestId('linked-page-current-variant')).toHaveText('"A"')
      await expect(page.getByTestId('linked-page-slug')).toHaveText('rewrite-a')
    })
  })

  test.describe('Dynamic import', () => {
    test('should scope dynamic import to initial deploy', async ({
      page,
      skewProtection,
      prepareSkewProtectionScenario,
    }) => {
      await prepareSkewProtectionScenario(async () => {
        return await page.goto(`${skewProtection.url}/dynamic-import`)
      })

      page.getByTestId('dynamic-import-button').click()

      const element = await page.waitForSelector('[data-testid="dynamic-import-result"]')
      const content = await element.textContent()

      // if skew protection does not work, this will be "B" (currently published deploy)
      expect(content).toBe(`"A"`)
    })
  })
})
