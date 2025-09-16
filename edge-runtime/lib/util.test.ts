import { assertEquals } from 'https://deno.land/std@0.175.0/testing/asserts.ts'
import { relativizeURL, rewriteDataPath } from './util.ts'

Deno.test('rewriteDataPath', async (t) => {
  await t.step('should rewrite a data url', async () => {
    const dataUrl = '/_next/data/build-id/rewrite-me.json'
    const newRoute = '/target'
    const result = rewriteDataPath({ dataUrl, newRoute })
    assertEquals(result, '/_next/data/build-id/target.json')
  })

  await t.step('should rewrite a data url with a base path', async () => {
    const dataUrl = '/baseDir/_next/data/build-id/rewrite-me.json'
    const newRoute = '/target'
    const result = rewriteDataPath({ dataUrl, newRoute, basePath: '/baseDir' })
    assertEquals(result, '/baseDir/_next/data/build-id/target.json')
  })

  await t.step('should rewrite from an index data url', async () => {
    const dataUrl = '/_next/data/build-id/index.json'
    const newRoute = '/target'
    const result = rewriteDataPath({ dataUrl, newRoute })
    assertEquals(result, '/_next/data/build-id/target.json')
  })

  await t.step('should rewrite to an index data url', async () => {
    const dataUrl = '/_next/data/build-id/rewrite-me.json'
    const newRoute = '/'
    const result = rewriteDataPath({ dataUrl, newRoute })
    assertEquals(result, '/_next/data/build-id/index.json')
  })

  await t.step('should rewrite to a route with a trailing slash', async () => {
    const dataUrl = '/_next/data/build-id/rewrite-me.json'
    const newRoute = '/target/'
    const result = rewriteDataPath({ dataUrl, newRoute })
    assertEquals(result, '/_next/data/build-id/target.json')
  })
})

Deno.test('relativizeURL', async (t) => {
  await t.step('should relativize a URL when origin matches', async () => {
    const url = 'https://example.com/pathname'
    const base = 'https://example.com/'
    const result = relativizeURL(url, base)
    assertEquals(result, '/pathname')
  })

  await t.step('should NOT relativize a URL when origin does not match', async () => {
    const url = 'https://example.com/pathname'
    const base = 'https://not-example.com/'
    const result = relativizeURL(url, base)
    assertEquals(result, 'https://example.com/pathname')
  })

  await t.step('accepts relative URL strings and produce relative URL as output', async () => {
    const url = '/pathname'
    const base = 'https://example.com/'
    const result = relativizeURL(url, base)
    assertEquals(result, '/pathname')
  })
})
