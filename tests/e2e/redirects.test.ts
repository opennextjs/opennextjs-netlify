import { expect } from '@playwright/test'
import { test } from '../utils/playwright-helpers.js'

test('should handle simple redirects at the edge', async ({ page, redirects }) => {
  const response = await page.request.get(`${redirects.url}/simple`, {
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status()).toBe(308)
  expect(response.headers()['location']).toBe('/dest')
  expect(response.headers()['debug-x-nf-function-type']).toBeUndefined()
})

test('should handle redirects with placeholders at the edge', async ({ page, redirects }) => {
  const response = await page.request.get(`${redirects.url}/with-placeholder/foo`, {
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status()).toBe(308)
  expect(response.headers()['location']).toBe('/dest/foo')
  expect(response.headers()['debug-x-nf-function-type']).toBeUndefined()
})

test('should handle redirects with splats at the edge', async ({ page, redirects }) => {
  const response = await page.request.get(`${redirects.url}/with-splat/foo/bar`, {
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status()).toBe(308)
  expect(response.headers()['location']).toBe('/dest/foo/bar')
  expect(response.headers()['debug-x-nf-function-type']).toBeUndefined()
})

test('should handle redirects with regex in the function', async ({ page, redirects }) => {
  const response = await page.request.get(`${redirects.url}/with-regex/123`, {
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status()).toBe(308)
  expect(response.headers()['location']).toBe('/dest-regex/123')
  expect(response.headers()['debug-x-nf-function-type']).toBe('request')
})

test('should handle redirects with `has` in the function', async ({ page, redirects }) => {
  const response = await page.request.get(`${redirects.url}/with-has`, {
    maxRedirects: 0,
    failOnStatusCode: false,
    headers: {
      'x-foo': 'bar',
    },
  })
  expect(response.status()).toBe(308)
  expect(response.headers()['location']).toBe('/dest-has')
  expect(response.headers()['debug-x-nf-function-type']).toBe('request')
})

test('should handle redirects with `missing` in the function', async ({ page, redirects }) => {
  const response = await page.request.get(`${redirects.url}/with-missing`, {
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status()).toBe(308)
  expect(response.headers()['location']).toBe('/dest-missing')
  expect(response.headers()['debug-x-nf-function-type']).toBe('request')
})
