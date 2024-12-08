import { expect } from '@playwright/test'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'
import { test } from '../utils/playwright-helpers.js'

test('next/after callback is executed and finishes', async ({ page, after }) => {
  test.skip(!nextVersionSatisfies('>=15.0.0'), 'This test is only for Next.js 15+')

  // trigger initial request to check page which might be stale and allow regenerating in background
  await page.goto(`${after.url}/after/check`)

  await new Promise((resolve) => setTimeout(resolve, 5000))

  // after it was possibly regenerated we can start checking actual content of the page
  await page.goto(`${after.url}/after/check`)
  const pageInfoLocator1 = await page.locator('#page-info')
  const pageInfo1 = JSON.parse((await pageInfoLocator1.textContent()) ?? '{}')

  expect(typeof pageInfo1?.timestamp, 'Check page should have timestamp').toBe('number')

  await page.goto(`${after.url}/after/check`)
  const pageInfoLocator2 = await page.locator('#page-info')
  const pageInfo2 = JSON.parse((await pageInfoLocator2.textContent()) ?? '{}')

  expect(typeof pageInfo2?.timestamp, 'Check page should have timestamp').toBe('number')

  expect(pageInfo2.timestamp, 'Check page should be cached').toBe(pageInfo1.timestamp)

  await page.goto(`${after.url}/after/trigger`)

  // wait for next/after to trigger revalidation of check page
  await new Promise((resolve) => setTimeout(resolve, 5000))

  await page.goto(`${after.url}/after/check`)
  const pageInfoLocator3 = await page.locator('#page-info')
  const pageInfo3 = JSON.parse((await pageInfoLocator3.textContent()) ?? '{}')

  expect(typeof pageInfo3?.timestamp, 'Check page should have timestamp').toBe('number')
  expect(
    pageInfo3.timestamp,
    'Check page should be invalidated with newer timestamp',
  ).toBeGreaterThan(pageInfo1.timestamp)
})
