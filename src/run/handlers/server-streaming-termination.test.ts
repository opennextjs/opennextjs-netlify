import type { OutgoingHttpHeaders } from 'node:http'

import { ComputeJsOutgoingMessage, toComputeResponse, toReqRes } from '@fastly/http-compute-js'
import { describe, expect, test } from 'vitest'

/**
 * Regression tests for streamed-response termination on render failure.
 *
 * A streamed SSR response commits its headers (typically a 200, with no
 * Content-Length) as soon as Next.js flushes them - well before the body
 * finishes. If the render then fails *after* that point, the response can no
 * longer become a 5xx, and the body must terminate cleanly or the edge sees an
 * unparseable HTTP message (which ATS reports as a 502,
 * ats_status_502_invalid_http_response).
 *
 * This faithfully mirrors the response-finalization pipeline in
 * `src/run/handlers/server.ts`:
 *   - `disableFaultyTransferEncodingHandling` (verbatim)
 *   - kicking off the next handler without awaiting it, capturing a late
 *     render failure and ending the response once headers are committed
 *   - `toComputeResponse(resProxy)` which resolves when HEADERS are available,
 *     NOT when the body stream closes
 *   - the body ReadableStream that keeps the response open until the render +
 *     background work finish, but errors the stream on a failed/aborted render
 *
 * We do not import server.ts directly because its module init does top-level
 * `await getRunConfig()` + Next.js imports. The streaming/termination logic
 * below is kept in lock-step with server.ts so the test exercises the real shape.
 *
 * Before the fix:
 *   - a mid-stream abort after headers -> response HUNG open indefinitely
 *   - a throw after headers -> client got a 200 with "Internal Server Error"
 *     concatenated onto partial HTML (a garbled but "complete" 200)
 *
 * After the fix: a failed/aborted render terminates the response stream
 * cleanly (errors), so the platform aborts the connection instead of emitting
 * an unparseable "success" or hanging.
 */

// --- verbatim from server.ts ---
const disableFaultyTransferEncodingHandling = (res: ComputeJsOutgoingMessage) => {
  const originalStoreHeader = res._storeHeader
  res._storeHeader = function _storeHeader(firstLine, headers) {
    if (headers) {
      if (Array.isArray(headers)) {
        // eslint-disable-next-line no-param-reassign
        headers = headers.filter(([header]) => header.toLowerCase() !== 'transfer-encoding')
      } else {
        delete (headers as OutgoingHttpHeaders)['transfer-encoding']
      }
    }
    return originalStoreHeader.call(this, firstLine, headers)
  }
}

type FakeNextHandler = (res: import('node:http').ServerResponse) => Promise<void>

/**
 * Mirror of the response-finalization half of server.ts's default export.
 * `render` plays the role of `nextHandler(req, resProxy)`.
 */
async function finalizeResponseLikeServerHandler(request: Request, render: FakeNextHandler) {
  const { req, res } = toReqRes(request)

  Object.defineProperty(req, 'connection', { get: () => ({}) })
  Object.defineProperty(req, 'socket', { get: () => ({}) })

  disableFaultyTransferEncodingHandling(res as unknown as ComputeJsOutgoingMessage)

  let handlerError: unknown
  const nextHandlerPromise = render(res).catch((error) => {
    if (res.headersSent) {
      handlerError = error instanceof Error ? error : new Error(String(error))
      res.end()
    } else {
      res.statusCode = 500
      res.end('Internal Server Error')
    }
  })

  const response = await toComputeResponse(res)

  async function waitForBackgroundWork() {
    await nextHandlerPromise
    res.emit('close')
  }

  if (!response.body) {
    await waitForBackgroundWork()
    return new Response(null, response)
  }

  const reader = response.body.getReader()

  const responseBody = new ReadableStream({
    start(controller) {
      nextHandlerPromise.then(() => {
        if (res.destroyed && !res.writableEnded) {
          const abortReason =
            handlerError ?? new Error('Response stream was destroyed before the render completed')
          try {
            controller.error(abortReason)
          } catch {
            // already closed/errored
          }
        }
      })
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          await waitForBackgroundWork()
          if (handlerError) controller.error(handlerError)
          else controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        try {
          controller.error(error)
        } catch {
          // already errored
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {})
    },
  })

  return new Response(responseBody, response)
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
      const timeout = new Promise<'hung'>((resolve) =>
        setTimeout(() => resolve('hung'), hangAfterMs),
      )
      const next = await Promise.race([reader.read(), timeout])
      if (next === 'hung') {
        reader.cancel().catch(() => {})
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

    const response = await finalizeResponseLikeServerHandler(request, async (res) => {
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
    const response = await finalizeResponseLikeServerHandler(request, async (res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<html><body>')
      await new Promise((r) => setTimeout(r, 10))
      res.destroy(new Error('stream aborted mid-render'))
    })

    // Headers were already committed as 200; we can't retroactively change that.
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('transfer-encoding')).toBeNull()

    const drained = await drainBody(response)
    // The response no longer hangs - it errors promptly and deterministically
    // so the platform aborts the connection (an explicit incomplete signal)
    // rather than holding an unterminated stream open until ATS times it out.
    expect(drained.outcome).toBe('errored')
    if (drained.outcome === 'errored') {
      expect(drained.partial.includes('</body></html>')).toBe(false)
    }
  })

  test('render throws after headers committed -> stream errors cleanly, no garbled 200 body', async () => {
    const request = new Request('https://example.netlify.app/throws/')

    const response = await finalizeResponseLikeServerHandler(request, async (res) => {
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
