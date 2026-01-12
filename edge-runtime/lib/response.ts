import type { Context } from '@netlify/edge-functions'

import { updateModifiedHeaders } from './headers.ts'
import type { StructuredLogger } from './logging.ts'
import { addMiddlewareHeaders, mergeMiddlewareCookies } from './middleware.ts'

import { relativizeURL } from './util.ts'

export interface FetchEventResult {
  response: Response
  waitUntil: Promise<any>
}

interface BuildResponseOptions {
  logger: StructuredLogger
  request: Request
  result: FetchEventResult
}

export const buildResponse = async ({
  logger,
  request,
  result,
}: BuildResponseOptions): Promise<Response | void> => {
  logger
    .withFields({ is_nextresponse_next: result.response.headers.has('x-middleware-next') })
    .debug('Building Next.js response')

  updateModifiedHeaders(request.headers, result.response.headers)

  const edgeResponse = new Response(result.response.body, result.response)
  return edgeResponse
  // request.headers.set('x-nf-next-middleware', 'skip')

  // let rewrite = edgeResponse.headers.get('x-middleware-rewrite')
  // let redirect = edgeResponse.headers.get('location')
  // let nextRedirect = edgeResponse.headers.get('x-nextjs-redirect')

  // // Data requests (i.e. requests for /_next/data ) need special handling
  // const isDataReq = request.headers.has('x-nextjs-data')
  // // Data requests need to be normalized to the route path
  // if (isDataReq && !redirect && !rewrite && !nextRedirect) {
  //   const requestUrl = new URL(request.url)
  //   const normalizedDataUrl = normalizeDataUrl(requestUrl.pathname)
  //   // Don't rewrite unless the URL has changed
  //   if (normalizedDataUrl !== requestUrl.pathname) {
  //     rewrite = `${normalizedDataUrl}${requestUrl.search}`
  //     logger.withFields({ rewrite_url: rewrite }).debug('Rewritten data URL')
  //   }
  // }

  // if (rewrite) {
  //   logger.withFields({ rewrite_url: rewrite }).debug('Found middleware rewrite')

  //   const rewriteUrl = new URL(rewrite, request.url)
  //   const baseUrl = new URL(request.url)
  //   if (rewriteUrl.toString() === baseUrl.toString()) {
  //     logger.withFields({ rewrite_url: rewrite }).debug('Rewrite url is same as original url')
  //     return
  //   }

  //   const relativeUrl = relativizeURL(rewrite, request.url)

  //   if (isDataReq) {
  //     // Data requests might be rewritten to an external URL
  //     // This header tells the client router the redirect target, and if it's external then it will do a full navigation

  //     edgeResponse.headers.set('x-nextjs-rewrite', relativeUrl)
  //   }

  //   if (rewriteUrl.origin !== baseUrl.origin) {
  //     logger.withFields({ rewrite_url: rewrite }).debug('Rewriting to external url')
  //     const proxyRequest = await cloneRequest(rewriteUrl, request)

  //     // Remove Netlify internal headers
  //     for (const key of request.headers.keys()) {
  //       if (key.startsWith('x-nf-')) {
  //         proxyRequest.headers.delete(key)
  //       }
  //     }

  //     return addMiddlewareHeaders(fetch(proxyRequest, { redirect: 'manual' }), edgeResponse)
  //   }

  //   const target = rewriteUrl.toString()
  //   if (target === request.url) {
  //     logger.withFields({ rewrite_url: rewrite }).debug('Rewrite url is same as original url')
  //     return
  //   }
  //   edgeResponse.headers.set('x-middleware-rewrite', relativeUrl)
  //   request.headers.set('x-middleware-rewrite', target)

  //   // coookies set in middleware need to be available during the lambda request
  //   const newRequest = await cloneRequest(target, request)
  //   const newRequestCookies = mergeMiddlewareCookies(edgeResponse, newRequest)
  //   if (newRequestCookies) {
  //     newRequest.headers.set('Cookie', newRequestCookies)
  //   }

  //   return addMiddlewareHeaders(context.next(newRequest), edgeResponse)
  // }

  // if (redirect) {
  //   if (redirect === request.url) {
  //     logger.withFields({ redirect_url: redirect }).debug('Redirect url is same as original url')
  //     return
  //   }
  //   edgeResponse.headers.set('location', relativizeURL(redirect, request.url))
  // }

  // // Data requests shouldn't automatically redirect in the browser (they might be HTML pages): they're handled by the router
  // if (redirect && isDataReq) {
  //   edgeResponse.headers.delete('location')
  //   edgeResponse.headers.set('x-nextjs-redirect', relativizeURL(redirect, request.url))
  // }

  // nextRedirect = edgeResponse.headers.get('x-nextjs-redirect')

  // if (nextRedirect && isDataReq) {
  //   edgeResponse.headers.set('x-nextjs-redirect', normalizeDataUrl(nextRedirect))
  // }

  // if (edgeResponse.headers.get('x-middleware-next') === '1') {
  //   edgeResponse.headers.delete('x-middleware-next')

  //   // coookies set in middleware need to be available during the lambda request
  //   const newRequest = await cloneRequest(request.url, request)
  //   const newRequestCookies = mergeMiddlewareCookies(edgeResponse, newRequest)
  //   if (newRequestCookies) {
  //     newRequest.headers.set('Cookie', newRequestCookies)
  //   }

  //   return addMiddlewareHeaders(context.next(newRequest), edgeResponse)
  // }

  // return edgeResponse
}

async function cloneRequest(url: URL | string, request: Request) {
  // This is not ideal, but streaming to an external URL doesn't work
  const body = request.body && !request.bodyUsed ? await request.arrayBuffer() : undefined
  return new Request(url, {
    headers: request.headers,
    method: request.method,
    body,
  })
}
