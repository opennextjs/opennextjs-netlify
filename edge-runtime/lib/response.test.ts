import { assertEquals } from 'https://deno.land/std@0.175.0/testing/asserts.ts'

import { buildResponse } from './response.ts'

// Mock logger that satisfies the StructuredLogger interface
const mockLogger = {
  withFields: () => mockLogger,
  debug: () => {},
  log: () => {},
  error: () => {},
}

// Mock context that satisfies the Netlify Context interface
const mockContext = {
  next: () => Promise.resolve(new Response('origin response')),
  geo: {},
  ip: '127.0.0.1',
  requestId: 'test-request-id',
  server: { region: 'test' },
  site: { id: 'test-site', name: 'test', url: 'https://test.netlify.app' },
  account: { id: 'test-account' },
  deploy: { id: 'test-deploy', context: 'production', published: true },
  cookies: { get: () => undefined, set: () => {}, delete: () => {} },
  json: (data: unknown) => new Response(JSON.stringify(data)),
  log: () => {},
  rewrite: () => new Response(),
}

// Helper to create a mock MiddlewareResponse
function createMockMiddlewareResponse(
  originResponse: Response,
  options: {
    dataTransforms?: Array<(data: Record<string, unknown>) => Record<string, unknown>>
    elementHandlers?: Array<[string, Record<string, unknown>]>
  } = {},
) {
  const headers = new Headers()
  return {
    body: null,
    bodyUsed: false,
    headers,
    ok: true,
    redirected: false,
    status: 200,
    statusText: 'OK',
    type: 'default' as ResponseType,
    url: '',
    clone: () => createMockMiddlewareResponse(originResponse, options),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    originResponse,
    dataTransforms: options.dataTransforms ?? [],
    elementHandlers: options.elementHandlers ?? [],
    cookies: { _headers: new Headers() },
  }
}

Deno.test('buildResponse without HTMLRewriter', async (t) => {
  await t.step('should handle simple response with x-middleware-next header', async () => {
    const simpleResponse = new Response('Hello World', {
      headers: { 'x-middleware-next': '1' },
    })

    const mockResult = {
      response: simpleResponse,
      waitUntil: Promise.resolve(),
    }

    const response = await buildResponse({
      context: mockContext as Parameters<typeof buildResponse>[0]['context'],
      logger: mockLogger as Parameters<typeof buildResponse>[0]['logger'],
      request: new Request('https://example.com/test'),
      result: mockResult,
      nextConfig: {},
    })

    assertEquals(response instanceof Response, true)
  })

  await t.step('should return originResponse when MiddlewareResponse has no transforms', async () => {
    const originResponse = new Response('Original content', {
      headers: { 'content-type': 'text/html' },
    })

    const middlewareResponse = createMockMiddlewareResponse(originResponse, {
      dataTransforms: [],
      elementHandlers: [],
    })

    const mockResult = {
      response: middlewareResponse as Parameters<typeof buildResponse>[0]['result']['response'],
      waitUntil: Promise.resolve(),
    }

    const response = await buildResponse({
      context: mockContext as Parameters<typeof buildResponse>[0]['context'],
      logger: mockLogger as Parameters<typeof buildResponse>[0]['logger'],
      request: new Request('https://example.com/test'),
      result: mockResult,
      nextConfig: {},
    })

    const body = await response!.text()
    assertEquals(body, 'Original content')
  })

  await t.step('should handle JSON responses without HTMLRewriter', async () => {
    const jsonData = { pageProps: { message: 'original' } }
    const originResponse = new Response(JSON.stringify(jsonData), {
      headers: { 'content-type': 'application/json' },
    })

    const middlewareResponse = createMockMiddlewareResponse(originResponse, {
      dataTransforms: [
        (data) => ({
          ...data,
          pageProps: { ...(data.pageProps as Record<string, unknown>), message: 'transformed' },
        }),
      ],
    })

    const mockResult = {
      response: middlewareResponse as Parameters<typeof buildResponse>[0]['result']['response'],
      waitUntil: Promise.resolve(),
    }

    const response = await buildResponse({
      context: mockContext as Parameters<typeof buildResponse>[0]['context'],
      logger: mockLogger as Parameters<typeof buildResponse>[0]['logger'],
      request: new Request('https://example.com/test'),
      result: mockResult,
      nextConfig: {},
    })

    const body = await response!.json()
    assertEquals(body.pageProps.message, 'transformed')
  })
})

// NOTE: Tests that exercise HTMLRewriter require the WASM to be populated.
// The source template (html-rewriter-wasm.ts) has a placeholder that's only
// replaced at build time when creating edge function handlers.
//
// HTMLRewriter functionality is tested via:
// 1. Integration tests that build real fixtures (tests/integration/middleware.test.ts)
// 2. E2E tests that run against deployed functions
//
// To run HTMLRewriter tests locally, you would need to:
// 1. Build a fixture: npm run build && node tests/prepare.mjs
// 2. Run tests against the built fixture's edge-runtime directory
