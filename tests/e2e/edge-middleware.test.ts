import { expect } from '@playwright/test'
import { nextVersionSatisfies } from '../utils/next-version-helpers.mjs'
import { test } from '../utils/playwright-helpers.js'
import { getImageSize } from 'next/dist/server/image-optimizer.js'

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

test('json data rewrite works', async ({ middlewarePages }) => {
  const response = await fetch(`${middlewarePages.url}/_next/data/build-id/sha.json`, {
    headers: {
      'x-nextjs-data': '1',
    },
  })

  expect(response.ok).toBe(true)
  const body = await response.text()

  expect(body).toMatch(/^{"pageProps":/)

  const data = JSON.parse(body)

  expect(data.pageProps.message).toBeDefined()
})
