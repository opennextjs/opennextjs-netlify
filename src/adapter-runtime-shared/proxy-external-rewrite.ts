// Proxies external rewrites over node:http/https (available in Node and Deno) rather than fetch():
// fetch transparently decodes the body, forcing content-encoding to be dropped, and adds its own
// accept-encoding. Next's own proxy forwards what the client asked for and streams upstream bytes and
// encoding through as-is; this does the same.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

// host is derived from the target, x-nf-* are Netlify internal, the rest is hop-by-hop / framing of
// the upstream connection
const DROPPED_REQUEST_HEADERS = new Set(['connection', 'host', 'keep-alive'])
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'transfer-encoding',
])

export function proxyExternalRewrite(url: URL, request: Request): Promise<Response> {
  const requestHeaders: Record<string, string> = {}
  for (const [name, value] of request.headers) {
    if (DROPPED_REQUEST_HEADERS.has(name) || name.startsWith('x-nf-')) {
      continue
    }
    requestHeaders[name] = value
  }

  return new Promise((resolve, reject) => {
    const makeRequest = url.protocol === 'https:' ? httpsRequest : httpRequest
    const proxyRequest = makeRequest(
      url,
      { method: request.method, headers: requestHeaders },
      (proxyResponse) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(proxyResponse.headers)) {
          if (DROPPED_RESPONSE_HEADERS.has(name)) {
            continue
          }
          for (const singleValue of Array.isArray(value) ? value : [value]) {
            if (singleValue !== undefined) {
              headers.append(name, singleValue)
            }
          }
        }
        const status = proxyResponse.statusCode ?? 502
        const hasBody = ![204, 304].includes(status) && request.method !== 'HEAD'
        resolve(
          new Response(hasBody ? (Readable.toWeb(proxyResponse) as ReadableStream) : null, {
            status,
            statusText: proxyResponse.statusMessage,
            headers,
          }),
        )
      },
    )
    proxyRequest.on('error', reject)

    if (request.body && !['GET', 'HEAD'].includes(request.method)) {
      Readable.fromWeb(request.body as NodeReadableStream).pipe(proxyRequest)
    } else {
      proxyRequest.end()
    }
  })
}
