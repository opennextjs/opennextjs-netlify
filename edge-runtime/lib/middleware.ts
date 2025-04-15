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

export function mergeMiddlewareCookies(middlewareResponse: Response, request: Request) {
  let mergedCookies = getCookies(request.headers)
  const middlewareCookies = middlewareResponse.headers.get('x-middleware-set-cookie') || ''
  const regex = new RegExp(/,(?!\s)/) // commas that are not followed by whitespace

  middlewareCookies.split(regex).forEach((entry) => {
    const [cookie] = entry.split(';')
    const [name, value] = cookie.split('=')
    mergedCookies[name] = value
  })

  return Object.entries(mergedCookies)
    .map((kv) => kv.join('='))
    .join('; ')
}
