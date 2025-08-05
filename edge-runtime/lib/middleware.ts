import type { Context } from '@netlify/edge-functions'

import type { ElementHandlers } from '../vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'
import { getCookies } from '../vendor/deno.land/std@0.175.0/http/cookie.ts'

type NextDataTransform = <T>(data: T) => T

interface ResponseCookies {
  // This is non-standard that Next.js adds.
  // https://github.com/vercel/next.js/blob/de08f8b3d31ef45131dad97a7d0e95fa01001167/packages/next/src/compiled/@edge-runtime/cookies/index.js#L158
  readonly _headers: Headers
}

interface MiddlewareResponse extends Response {
  originResponse: Response
  dataTransforms: NextDataTransform[]
  elementHandlers: Array<[selector: string, handlers: ElementHandlers]>
  get cookies(): ResponseCookies
}

interface MiddlewareRequest {
  request: Request
  context: Context
  originalRequest: Request
  next(): Promise<MiddlewareResponse>
  rewrite(destination: string | URL, init?: ResponseInit): Response
}

export function isMiddlewareRequest(
  response: Response | MiddlewareRequest,
): response is MiddlewareRequest {
  return 'originalRequest' in response
}

export function isMiddlewareResponse(
  response: Response | MiddlewareResponse,
): response is MiddlewareResponse {
  return 'dataTransforms' in response
}

export const addMiddlewareHeaders = async (
  originResponse: Promise<Response> | Response,
  middlewareResponse: Response,
) => {
  // If there are extra headers, we need to add them to the response.
  if ([...middlewareResponse.headers.keys()].length === 0) {
    return originResponse
  }

  // We need to await the response to get the origin headers, then we can add the ones from middleware.
  const res = await originResponse
  const response = new Response(res.body, res)
  middlewareResponse.headers.forEach((value, key) => {
    if (key === 'set-cookie') {
      response.headers.append(key, value)
    } else {
      response.headers.set(key, value)
    }
  })
  return response
}

// This serves the same purpose as the mergeMiddlewareCookies in Next.js but has been customized to our domain
// See: https://github.com/vercel/next.js/blob/6e4495f8430eab33b12cd11dffdd8e27eee6e0cf/packages/next/src/server/async-storage/request-store.ts#L78-L105
export function mergeMiddlewareCookies(middlewareResponse: Response, lambdaRequest: Request) {
  let mergedCookies = getCookies(lambdaRequest.headers)
  const middlewareCookies = middlewareResponse.headers.get('x-middleware-set-cookie')

  if (middlewareCookies) {
    // Next expects internal headers to be omitted when cookies are set by the middleware
    // See: https://github.com/vercel/next.js/blob/005db43079c7b59fd8c2594e8362761dc4cb3211/test/e2e/app-dir/app-middleware/app-middleware.test.ts#L197-L207
    middlewareResponse.headers.delete('x-middleware-set-cookie')

    // Targets commas that are not followed by whitespace
    // See: https://github.com/vercel/next.js/blob/e6145d3a37bb4c7b481fd58e05cdff9046ace8ad/packages/next/src/server/web/spec-extension/response.ts#L58-L66
    const regex = new RegExp(/,(?!\s)/)

    middlewareCookies.split(regex).forEach((entry) => {
      // Extra directives within a cookie are joined on separated by "; "
      // See: https://github.com/vercel/next.js/blob/0edb1123066a010eff2aac274f948ca2c6e85c0f/packages/next/src/compiled/%40edge-runtime/cookies/index.js#L32-L47
      const [cookie] = entry.split('; ')
      const [name, value] = cookie.split('=')
      mergedCookies[name] = value
    })
  }

  return Object.entries(mergedCookies)
    .map((kv) => kv.join('='))
    .join('; ')
}
