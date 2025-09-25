import { expect, type Locator } from '@playwright/test'
import { generateTestTags, test } from '../utils/playwright-helpers.js'
import { generate } from 'fast-glob/out/managers/tasks.js'

const expectImageWasLoaded = async (locator: Locator) => {
  expect(await locator.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBeGreaterThan(0)
}

test.describe(
  'NX integrated',
  { tag: generateTestTags({ appRouter: true, monorepo: true }) },
  () => {
    test('Renders the Home page correctly', async ({ page, nxIntegrated }) => {
      await page.goto(nxIntegrated.url)

      await expect(page).toHaveTitle('Welcome to next-app')

      const h1 = page.locator('h1')
      await expect(h1).toHaveText('Hello there,\nWelcome next-app 👋')

      // test additional netlify.toml settings
      await page.goto(`${nxIntegrated.url}/api/static`)
      const body = (await page.$('body').then((el) => el?.textContent())) || '{}'
      expect(body).toBe('{"words":"hello world"}')
    })

    test(
      'Renders the Home page correctly with distDir',
      { tag: generateTestTags({ customDistDir: true }) },
      async ({ page, nxIntegratedDistDir }) => {
        await page.goto(nxIntegratedDistDir.url)

        await expect(page).toHaveTitle('Simple Next App')

        const h1 = page.locator('h1')
        await expect(h1).toHaveText('Home')

        await expectImageWasLoaded(page.locator('img'))
      },
    )

    test(
      'environment variables from .env files should be available for functions',
      { tag: generateTestTags({ customDistDir: true }) },
      async ({ nxIntegratedDistDir }) => {
        const response = await fetch(`${nxIntegratedDistDir.url}/api/env`)
        const data = await response.json()
        expect(data).toEqual({
          '.env': 'defined in .env',
          '.env.local': 'defined in .env.local',
          '.env.production': 'defined in .env.production',
          '.env.production.local': 'defined in .env.production.local',
        })
      },
    )
  },
)
