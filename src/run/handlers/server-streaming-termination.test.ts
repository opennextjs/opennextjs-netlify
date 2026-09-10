import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@netlify/functions'
import { describe, expect, test, vi } from 'vitest'

import { createRequestContext, type RequestContext } from './request-context.cjs'
import handler from './server.js'

/**
 * Regression tests for streamed-response termination on render failure.
 *
 * A streamed SSR response commits its headers (typically a 200, with no
 * Content-Length) as soon as Next.js flushes them - well before the body
 * finishes. If the render then fails *after* that point, the response can no
 * longer become a 5xx, and the body must terminate cleanly or the edge sees a
 * malformed HTTP message and rejects the response.
 *
 * These tests exercise the *real* `server.ts` default export. The only thing we
 * substitute is the Next.js request handler itself (the `nextHandler` that
 * `getMockedRequestHandler` produces): each test injects a fake handler via
 * `mockNextHandler` that plays out a specific render scenario against the
 * (real) response object. Everything else - the response-finalization pipeline,
 * `disableFaultyTransferEncodingHandling`, `toComputeResponse`, and the body
 * `ReadableStream` that ties termination to the render - runs as it does in
 * production.
 *
 * server.ts pulls in Next.js and reads build output at module-init time, so the
 * heavy boundaries it touches (config loading, the Next.js import, storage,
 * tracing, header post-processing, wait-until/use-cache setup) are mocked out
 * below. None of them participate in the streaming/termination logic under test.
 *
 * Before the fix:
 *   - a mid-stream abort after headers -> response HUNG open indefinitely
 *   - a throw after headers -> client got a 200 with "Internal Server Error"
 *     concatenated onto partial HTML (a garbled but "complete" 200)
 *
 * After the fix: a failed/aborted render terminates the response stream
 * cleanly (errors), so the platform aborts the connection instead of emitting
 * a malformed "success" or hanging.
 */

type FakeNextHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

// The fake Next.js handler the mocked `getMockedRequestHandler` delegates to.
// `ref.current` is the render scenario each test swaps in; `handler` is the
// stable wrapper server.ts caches as its `nextHandler`.
const mockNextHandler = vi.hoisted(() => {
  const ref: { current: FakeNextHandler | undefined } = { current: undefined }
  return {
    ref,
    handler: (req: IncomingMessage, res: ServerResponse) => ref.current?.(req, res),
  }
})

// Only two boundaries of server.ts need stubbing; everything else (tracing,
// header post-processing, storage, wait-until/use-cache setup) runs for real.
//
//  - `../config.js`: server.ts does a top-level `await getRunConfig()` that
//    reads build output from disk, and `setRunConfig` asserts the compiled
//    cache handler exists - neither is present in a unit-test run.
//  - `../next.cjs`: this is the module that imports Next.js itself, and it is
//    where the `nextHandler` is created. Stubbing `getMockedRequestHandler`
//    lets each test inject the render scenario it wants to exercise.

vi.mock('../config.js', () => ({
  getRunConfig: async () => ({ nextConfig: {}, enableUseCacheHandler: false }),
  setRunConfig: (config: unknown) => config,
}))

vi.mock('../next.cjs', () => ({
  // Returns the request handler server.ts caches as `nextHandler`. We hand back
  // a thin wrapper that defers to whatever the current test installed, so each
  // test controls the render behavior while the real server pipeline runs.
  getMockedRequestHandler: async () => mockNextHandler.handler,
}))

/**
 * Drive the real server handler with a given fake render, returning the Response
 * it produces.
 */
function handleRequest(request: Request, render: FakeNextHandler): Promise<Response> {
  mockNextHandler.ref.current = render
  const requestContext: RequestContext = createRequestContext(request)
  return handler(request, {} as Context, undefined, requestContext)
}

type DrainResult =
  | { outcome: 'complete'; body: string }
  | { outcome: 'errored'; partial: string; error: unknown }
  | { outcome: 'hung'; partial: string }

/**
 * Drain the response body, but give up after `hangAfterMs`. The pre-fix bug
 * manifested as a body stream that never terminated, so the bound is required
 * to keep the assertion deterministic.
 */
async function drainBody(response: Response, hangAfterMs = 500): Promise<DrainResult> {
  if (!response.body) return { outcome: 'complete', body: '' }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''
  try {
    for (;;) {
      const timeout = new Promise<'hung'>((resolve) => {
        setTimeout(() => resolve('hung'), hangAfterMs)
      })
      const next = await Promise.race([reader.read(), timeout])
      if (next === 'hung') {
        reader.cancel().catch(() => {
          // best-effort cancel; nothing to do if it rejects
        })
        return { outcome: 'hung', partial: body }
      }
      const { done, value } = next
      if (done) break
      if (value) body += decoder.decode(value, { stream: true })
    }
    return { outcome: 'complete', body }
  } catch (error) {
    return { outcome: 'errored', partial: body, error }
  }
}

describe('streamed response termination', () => {
  test('baseline: a render that completes cleanly produces a well-framed 200', async () => {
    const request = new Request('https://example.netlify.app/page/')

    const response = await handleRequest(request, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<html><body>')
      res.write('fully rendered page')
      res.end('</body></html>')
    })

    expect(response.status).toBe(200)
    const drained = await drainBody(response)
    expect(drained.outcome).toBe('complete')
    if (drained.outcome === 'complete') {
      expect(drained.body).toBe('<html><body>fully rendered page</body></html>')
    }
  })

  test('render aborts mid-stream after headers committed -> stream errors cleanly (no hang)', async () => {
    const request = new Request('https://example.netlify.app/heavy-page/')

    // headers + opening HTML flush early, then a later async step (e.g. a data
    // fetch) aborts the render. The handler promise does NOT reject: it just
    // destroys the response.
    const response = await handleRequest(request, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<html><body>')
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })
      res.destroy(new Error('stream aborted mid-render'))
    })

    // Headers were already committed as 200; we can't retroactively change that.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('transfer-encoding')).toBeNull()

    const drained = await drainBody(response)
    // The response no longer hangs - it errors promptly and deterministically
    // so the platform aborts the connection (an explicit incomplete signal)
    // rather than holding an unterminated stream open until the edge times it out.
    expect(drained.outcome).toBe('errored')
    if (drained.outcome === 'errored') {
      expect(drained.partial.includes('</body></html>')).toBe(false)
    }
  })

  test('render throws after headers committed -> stream errors cleanly, no garbled 200 body', async () => {
    const request = new Request('https://example.netlify.app/throws/')

    const response = await handleRequest(request, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<html><body>partial')
      throw new Error('render failed mid-stream')
    })

    // Headers already committed; status stays 200 but the body must abort.
    expect(response.status).toBe(200)

    const drained = await drainBody(response)
    // Instead of a "complete" 200 with "Internal Server Error" concatenated onto
    // the partial HTML, the stream errors. Whatever bytes arrive first are a
    // truncated page; the error string is never appended.
    expect(drained.outcome).toBe('errored')
    if (drained.outcome === 'errored') {
      expect(drained.partial).not.toContain('Internal Server Error')
      expect(drained.partial.includes('</body></html>')).toBe(false)
    }
  })
})
