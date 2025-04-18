import { assertEquals } from 'https://deno.land/std@0.175.0/testing/asserts.ts'
import { mergeMiddlewareCookies } from './middleware.ts'

const MIDDLEWARE_HEADER = 'x-middleware-set-cookie'

Deno.test('mergeMiddlewareCookies', async (t) => {
  await t.step('should handle empty cookies', async () => {
    const request = new Request('https://www.test-url.com')
    const response = new Response()

    const result = mergeMiddlewareCookies(response, request)
    assertEquals(result, '')
  })

  await t.step('should return request cookies when there are no middleware headers', async () => {
    const request = new Request('https://www.test-url.com')
    const response = new Response()

    request.headers.set('Cookie', 'oatmeal=raisin')

    const result = mergeMiddlewareCookies(response, request)
    assertEquals(result, 'oatmeal=raisin')
  })

  await t.step('should not require cookies in request to be set', async () => {
    const request = new Request('https://www.test-url.com')
    const response = new Response()

    response.headers.set(MIDDLEWARE_HEADER, 'peanut=butter; Path=/')

    const result = mergeMiddlewareCookies(response, request)
    assertEquals(result, 'peanut=butter')
  })

  await t.step('should merge request and middleware cookies', async () => {
    const request = new Request('https://www.test-url.com')
    const response = new Response()

    request.headers.set('Cookie', 'oatmeal=raisin')
    response.headers.set(MIDDLEWARE_HEADER, 'peanut=butter; Path=/')

    const result = mergeMiddlewareCookies(response, request)
    assertEquals(result, 'oatmeal=raisin; peanut=butter')
  })

  await t.step('should overwrite request cookies with latest values', async () => {
    const request = new Request('https://www.test-url.com')
    const response = new Response()

    request.headers.set('Cookie', 'oatmeal=chocolate')
    response.headers.set(MIDDLEWARE_HEADER, 'oatmeal=raisin; Path=/')

    const result = mergeMiddlewareCookies(response, request)
    assertEquals(result, 'oatmeal=raisin')
  })

  await t.step('should not decode middleware cookie values', async () => {
    const request = new Request('https://www.test-url.com')
    const response = new Response()

    response.headers.set(MIDDLEWARE_HEADER, 'greeting=Hello%20from%20the%20cookie; Path=/')

    const result = mergeMiddlewareCookies(response, request)
    assertEquals(result, 'greeting=Hello%20from%20the%20cookie')
  })

  await t.step('should support multiple cookies being set in middleware', async () => {
    const request = new Request('https://www.test-url.com')
    const response = new Response()

    response.headers.set(
      MIDDLEWARE_HEADER,
      'oatmeal=raisin; Path=/,peanut=butter; Path=/,chocolate=chip; Path=/',
    )

    const result = mergeMiddlewareCookies(response, request)
    assertEquals(result, 'oatmeal=raisin; peanut=butter; chocolate=chip')
  })

  await t.step('should ignore comma in middleware cookie expiry', async () => {
    const request = new Request('https://www.test-url.com')
    const response = new Response()

    response.headers.set(
      MIDDLEWARE_HEADER,
      'oatmeal=raisin; Path=/; Expires=Wed, 23 Apr 2025 13:37:43 GMT; Max-Age=604800',
    )

    const result = mergeMiddlewareCookies(response, request)
    assertEquals(result, 'oatmeal=raisin')
  })
})
