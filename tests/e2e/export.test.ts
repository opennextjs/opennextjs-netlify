import { expect, type Locator } from '@playwright/test'
import { generateTestTags, test } from '../utils/playwright-helpers.js'

const expectImageWasLoaded = async (locator: Locator) => {
  expect(await locator.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBeGreaterThan(0)
}

test.describe(
  'Static export',
  {
    tag: generateTestTags({ appRouter: true, export: true }),
  },
  () => {
    test('Renders the Home page correctly with output export', async ({ page, outputExport }) => {
      await page.goto(outputExport.url)

      await expect(page).toHaveTitle('Simple Next App')

      const h1 = page.locator('h1')
      await expect(h1).toHaveText('Home')

      await expectImageWasLoaded(page.locator('img'))
    })

    test('Renders the Home page correctly with output export and publish set to out', async ({
      page,
      outputExportPublishOut,
    }) => {
      await page.goto(outputExportPublishOut.url)

      await expect(page).toHaveTitle('Simple Next App')

      const h1 = page.locator('h1')
      await expect(h1).toHaveText('Home')

      await expectImageWasLoaded(page.locator('img'))
    })

    test(
      'Renders the Home page correctly with output export and custom dist dir',
      {
        tag: generateTestTags({ customDistDir: true }),
      },
      async ({ page, outputExportCustomDist }) => {
        await page.goto(outputExportCustomDist.url)

        await expect(page).toHaveTitle('Simple Next App')

        const h1 = page.locator('h1')
        await expect(h1).toHaveText('Home')

        await expectImageWasLoaded(page.locator('img'))
      },
    )

    test.describe('next/image is using Netlify Image CDN', () => {
      test('Local images', async ({ page, outputExport }) => {
        const nextImageResponsePromise = page.waitForResponse('**/.netlify/images**')

        await page.goto(`${outputExport.url}/image/local`)

        const nextImageResponse = await nextImageResponsePromise
        expect(nextImageResponse.request().url()).toContain('.netlify/images?url=%2Fsquirrel.jpg')

        expect(nextImageResponse.status()).toBe(200)
        // ensure next/image is using Image CDN
        // source image is jpg, but when requesting it through Image CDN avif or webp will be returned
        expect(['image/avif', 'image/webp']).toContain(
          await nextImageResponse.headerValue('content-type'),
        )

        await expectImageWasLoaded(page.locator('img'))
      })
    })
  },
)
