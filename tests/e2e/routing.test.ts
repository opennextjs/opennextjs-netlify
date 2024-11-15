import { expect } from '@playwright/test'
import { test } from '../utils/playwright-helpers.js'

const ssrRoutes = [
  ['/static', 'pages router, static rendering, static routing'],
  ['/prerendered', 'pages router, prerendering, static routing'],
  ['/posts/prerendered/1', 'pages router, prerendering, dynamic routing'],
  ['/dynamic', 'pages router, dynamic rendering, static routing'],
  ['/posts/dynamic/1', 'pages router, dynamic rendering, dynamic routing'],
  ['/api/okay', 'pages router, api route, static routing'],
  ['/api/posts/1', 'pages router, api route, dynamic routing'],
  ['/static-fetch-1', 'app router, prerendering, static routing'],
  ['/static-fetch/1', 'app router, prerendering, dynamic routing'],
  ['/static-fetch-dynamic-1', 'app router, dynamic rendering, static routing'],
  ['/static-fetch-dynamic/1', 'app router, dynamic rendering, dynamic routing'],
  ['/api/revalidate-handler', 'app router, route handler, static routing'],
  ['/api/static/1', 'app router, route handler, dynamic routing'],
]

const notFoundRoutes = [
  ['/non-existing', 'default'],
  ['/prerendered/3', 'prerendering, dynamic routing'],
  ['/dynamic/3', 'dynamic rendering, dynamic routing'],
  ['/api/non-existing', 'route handler, static routing'],
]

test(`routing works correctly`, async ({ page, serverComponents }) => {
  for (const [path, description] of ssrRoutes) {
    const url = new URL(path, serverComponents.url).href
    const response = await page.goto(url)
    expect(response?.status(), `expected 200 response for ${description}`).toBe(200)
  }
  for (const [path, description] of notFoundRoutes) {
    const url = new URL(path, serverComponents.url).href
    const response = await page.goto(url)
    expect(response?.status(), `expected 404 response for ${description}`).toBe(404)
  }
})
