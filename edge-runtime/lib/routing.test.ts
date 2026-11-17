import { assertEquals } from 'https://deno.land/std@0.175.0/testing/asserts.ts'
import { getMiddlewareRouteMatcher } from './routing.ts'

const req = { headers: new Headers(), url: 'https://example.com/' }

Deno.test('getMiddlewareRouteMatcher', async (t) => {
  await t.step('matches encoded pathname with dynamic segment', () => {
    // matcher produced by Next.js for `/:tenant/dash/:path*`
    const matches = getMiddlewareRouteMatcher([
      {
        regexp:
          '^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/([^\\/#\\?]+?))\\/dash(?:\\/((?:[^\\/#\\?]+?)(?:\\/(?:[^\\/#\\?]+?))*))?(\\.json)?[\\/#\\?]?$',
      },
    ])

    assertEquals(matches('/acme/dash/secret', req, {}), true)
    // decoded pathname has an empty segment (`/acme//dash`), so only raw pathname matches
    assertEquals(matches('/acme%2F/dash/secret', req, {}), true)
    assertEquals(matches('/acme:%2F/dash/secret', req, {}), true)
    assertEquals(matches('/acme%3A%2F/dash/secret', req, {}), true)
    assertEquals(matches('/acme/secret', req, {}), false)
  })

  await t.step('matches decoded pathname', () => {
    // matcher produced by Next.js for `/café/:path*`
    const matches = getMiddlewareRouteMatcher([
      {
        regexp:
          '^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/café(?:\\/((?:[^\\/#\\?]+?)(?:\\/(?:[^\\/#\\?]+?))*))?(\\.json)?[\\/#\\?]?$',
      },
    ])

    assertEquals(matches('/caf%C3%A9/secret', req, {}), true)
    assertEquals(matches('/café/secret', req, {}), true)
    assertEquals(matches('/cafe/secret', req, {}), false)
  })
})
