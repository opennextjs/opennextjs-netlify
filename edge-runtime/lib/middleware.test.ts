import { assertEquals, assertStrictEquals } from 'https://deno.land/std@0.175.0/testing/asserts.ts'
import { mergeMiddlewareCookies, removeInternalCookieHeader } from './middleware.ts'

const MIDDLEWARE_HEADER = 'x-middleware-set-cookie'

Deno.test('removeInternalCookieHeader', async (t) => {
  await t.step('should return the same response when the header is not set', () => {
    const response = new Response('body')

    assertStrictEquals(removeInternalCookieHeader(response), response)
  })

  await t.step('should remove the header and keep the rest of the response', async () => {
    const headers = new Headers({ [MIDDLEWARE_HEADER]: 'a=1; Path=/; HttpOnly,b=2; Path=/' })
    headers.append('set-cookie', 'a=1; Path=/; HttpOnly')
    headers.append('set-cookie', 'b=2; Path=/')
    const response = new Response('body', { status: 201, headers })

    const result = removeInternalCookieHeader(response)

    assertEquals(result.headers.get(MIDDLEWARE_HEADER), null)
    assertEquals(result.headers.getSetCookie(), ['a=1; Path=/; HttpOnly', 'b=2; Path=/'])
    assertEquals(result.status, 201)
    assertEquals(await result.text(), 'body')
  })

  await t.step('should remove the header from responses with immutable headers', async () => {
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, () => {
      return new Response('body', { headers: { [MIDDLEWARE_HEADER]: 'a=1; Path=/; HttpOnly' } })
    })
    try {
      const response = await fetch(`http://127.0.0.1:${server.addr.port}`)

      const result = removeInternalCookieHeader(response)

      assertEquals(result.headers.get(MIDDLEWARE_HEADER), null)
      assertEquals(await result.text(), 'body')
    } finally {
      await server.shutdown()
    }
  })
})

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
