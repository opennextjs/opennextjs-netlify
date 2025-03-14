import { test as base, PlaywrightWorkerArgs, WorkerFixture, Page, expect } from '@playwright/test'
import { Fixture, fixtureFactories } from './create-e2e-fixture'

const makeE2EFixture = (
  createFixture: () => Promise<Fixture>,
): [WorkerFixture<Fixture, PlaywrightWorkerArgs>, { scope: 'worker' }] => [
  async ({}, use) => {
    const fixture = await createFixture()
    await use(fixture)
    await fixture.cleanup() // TODO: replace false with info about test results
  },
  { scope: 'worker' },
]

export const test = base.extend<
  {
    ensureStaticAssetsHaveImmutableCacheControl: void
    takeScreenshot: void
    pollUntilHeadersMatch: (
      url: string,
      options: Parameters<Page['goto']>[1] & {
        headersToMatch: Record<string, RegExp | Array<RegExp>>
        headersNotMatchedMessage?: string
      },
    ) => ReturnType<Page['goto']>
  },
  {
    [Property in keyof typeof fixtureFactories]: Fixture
  }
>({
  ...Object.fromEntries(
    Object.entries(fixtureFactories).map(([key, f]) => [key, makeE2EFixture(f)]),
  ),
  pollUntilHeadersMatch: async ({ page }, use) => {
    await use(async (url, options) => {
      const start = Date.now()
      const timeout = options.timeout || 10000
      const { headersToMatch, headersNotMatchedMessage, ...gotoOptions } = options
      let response: Awaited<ReturnType<Page['goto']>>

      pollLoop: do {
        response = await page.goto(url, gotoOptions)

        for (const [header, expected] of Object.entries(headersToMatch)) {
          const actual = response?.headers()[header]

          if (!actual) {
            await new Promise((r) => setTimeout(r, 100))
            continue pollLoop
          }

          const headerMatches = Array.isArray(expected) ? expected : [expected]

          for (const match of headerMatches) {
            if (!match.test(actual)) {
              await new Promise((r) => setTimeout(r, 100))
              continue pollLoop
            }
          }
        }

        return response
      } while (Date.now() - start <= timeout)

      // if we didn't return a matching response - we will fail with regular assertions
      for (const [header, expected] of Object.entries(headersToMatch)) {
        const actual = response?.headers()[header]

        const headerMatches = Array.isArray(expected) ? expected : [expected]
        for (const match of headerMatches) {
          expect(actual, headersNotMatchedMessage).toMatch(match)
        }
      }

      return response
    })
  },
  takeScreenshot: [
    async ({ page }, use, testInfo) => {
      await use()

      if (testInfo.status !== testInfo.expectedStatus) {
        const screenshotPath = testInfo.outputPath(`failure.png`)
        // Add it to the report to see the failure immediately
        testInfo.attachments.push({
          name: 'failure',
          path: screenshotPath,
          contentType: 'image/png',
        })
        await page.screenshot({ path: screenshotPath, timeout: 5000 })
      }
    },
    { auto: true },
  ],
  ensureStaticAssetsHaveImmutableCacheControl: [
    async ({ page }, use) => {
      page.on('response', (response) => {
        if (response.url().includes('/_next/static/')) {
          expect(
            response.headers()['cache-control'],
            '_next/static assets should have immutable cache control',
          ).toContain('public,max-age=31536000,immutable')
        }
      })

      await use()
    },
    { auto: true },
  ],
})
