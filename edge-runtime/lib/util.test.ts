import { assertEquals } from 'https://deno.land/std@0.175.0/testing/asserts.ts'
import { addLocale, isDataPath, relativizeURL, rewriteDataPath } from './util.ts'

Deno.test('addLocale', async (t) => {
  await t.step('adds the locale to a path without one', () => {
    assertEquals(addLocale('/admin/secret', 'en'), '/en/admin/secret')
  })

  await t.step('adds the locale to an api path', () => {
    assertEquals(addLocale('/api/secret', 'en'), '/en/api/secret')
  })

  await t.step('keeps a locale in any letter case', () => {
    assertEquals(addLocale('/EN/admin/secret', 'en'), '/EN/admin/secret')
    assertEquals(addLocale('/en-us/admin/secret', 'en-US'), '/en-us/admin/secret')
  })

  await t.step('does not add the locale to a _next path', () => {
    assertEquals(addLocale('/_next/static/chunk.js', 'en'), '/_next/static/chunk.js')
  })
})

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

  await t.step('should not replace a build id that starts with the route', async () => {
    const dataUrl = '/_next/data/abc123/a.json'
    const newRoute = '/target'
    const result = rewriteDataPath({ dataUrl, newRoute })
    assertEquals(result, '/_next/data/abc123/target.json')
  })

  await t.step(
    'should not replace a build id that starts with the route under a base path',
    async () => {
      const dataUrl = '/baseDir/_next/data/abc123/a.json'
      const newRoute = '/target'
      const result = rewriteDataPath({ dataUrl, newRoute, basePath: '/baseDir' })
      assertEquals(result, '/baseDir/_next/data/abc123/target.json')
    },
  )

  await t.step('should rewrite a locale index data url', async () => {
    const dataUrl = '/_next/data/build-id/en.json'
    const newRoute = '/en/target'
    const result = rewriteDataPath({ dataUrl, newRoute })
    assertEquals(result, '/_next/data/build-id/en/target.json')
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

Deno.test('isDataPath', async (t) => {
  await t.step('matches data URLs', () => {
    assertEquals(isDataPath('/_next/data/build-id/en/page.json'), true)
    assertEquals(isDataPath('/_next/data/build-id/index.json'), true)
  })

  await t.step('matches data URLs under basePath', () => {
    assertEquals(isDataPath('/base/_next/data/build-id/page.json', '/base'), true)
  })

  await t.step('does not match page or static URLs', () => {
    assertEquals(isDataPath('/en/page'), false)
    assertEquals(isDataPath('/_next/static/chunks/main.js'), false)
    assertEquals(isDataPath('/_next/data/build-id/page'), false)
  })

  await t.step('does not match paths that only contain .json', () => {
    // middleware only parses /_next/data URLs ending in .json as data requests
    assertEquals(isDataPath('/_next/data/build-id/page.json/extra'), false)
  })
})
