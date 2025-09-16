import type { Context } from '@netlify/edge-functions'
import {
  HTMLRewriter,
  type TextChunk,
} from '../vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'

import { updateModifiedHeaders } from './headers.ts'
import type { StructuredLogger } from './logging.ts'
import {
  addMiddlewareHeaders,
  isMiddlewareRequest,
  isMiddlewareResponse,
  mergeMiddlewareCookies,
} from './middleware.ts'
import { RequestData } from './next-request.ts'
import {
  addBasePath,
  normalizeDataUrl,
  normalizeLocalePath,
  normalizeTrailingSlash,
  relativizeURL,
  removeBasePath,
  rewriteDataPath,
} from './util.ts'

export interface FetchEventResult {
  response: Response
  waitUntil: Promise<any>
}

interface BuildResponseOptions {
  context: Context
  logger: StructuredLogger
  request: Request
  result: FetchEventResult
  nextConfig?: RequestData['nextConfig']
}

export const buildResponse = async ({
  context,
  logger,
  request,
  result,
  nextConfig,
}: BuildResponseOptions): Promise<Response | void> => {
  logger
    .withFields({ is_nextresponse_next: result.response.headers.has('x-middleware-next') })
    .debug('Building Next.js response')

  updateModifiedHeaders(request.headers, result.response.headers)

  // They've returned the MiddlewareRequest directly, so we'll call `next()` for them.
  if (isMiddlewareRequest(result.response)) {
    result.response = await result.response.next()
  }

  if (isMiddlewareResponse(result.response)) {
    const { response } = result
    if (request.method === 'HEAD' || request.method === 'OPTIONS') {
      return response.originResponse
    }

    // NextResponse doesn't set cookies onto the originResponse, so we need to copy them over
    // In some cases, it's possible there are no headers set. See https://github.com/netlify/pod-ecosystem-frameworks/issues/475
    if (response.cookies._headers?.has('set-cookie')) {
      response.originResponse.headers.set(
        'set-cookie',
        response.cookies._headers.get('set-cookie')!,
      )
    }

    // If it's JSON we don't need to use the rewriter, we can just parse it
    if (response.originResponse.headers.get('content-type')?.includes('application/json')) {
      const props = await response.originResponse.json()
      const transformed = response.dataTransforms.reduce((prev, transform) => {
        return transform(prev)
      }, props)
      const body = JSON.stringify(transformed)
      const headers = new Headers(response.headers)
      headers.set('content-length', String(body.length))

      return Response.json(transformed, { ...response, headers })
    }

    // This var will hold the contents of the script tag
    let buffer = ''
    // Create an HTMLRewriter that matches the Next data script tag
    const rewriter = new HTMLRewriter()

    if (response.dataTransforms.length > 0) {
      rewriter.on('script[id="__NEXT_DATA__"]', {
        text(textChunk: TextChunk) {
          // Grab all the chunks in the Next data script tag
          buffer += textChunk.text
          if (textChunk.lastInTextNode) {
            try {
              // When we have all the data, try to parse it as JSON
              const data = JSON.parse(buffer.trim())
              // Apply all of the transforms to the props
              const props = response.dataTransforms.reduce(
                (prev, transform) => transform(prev),
                data.props,
              )
              // Replace the data with the transformed props
              // With `html: true` the input is treated as raw HTML
              // @see https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/#global-types
              textChunk.replace(JSON.stringify({ ...data, props }), { html: true })
            } catch (err) {
              console.log('Could not parse', err)
            }
          } else {
            // Remove the chunk after we've appended it to the buffer
            textChunk.remove()
          }
        },
      })
    }

    if (response.elementHandlers.length > 0) {
      response.elementHandlers.forEach(([selector, handlers]) => rewriter.on(selector, handlers))
    }
    return rewriter.transform(response.originResponse)
  }

  const edgeResponse = new Response(result.response.body, result.response)
  request.headers.set('x-nf-next-middleware', 'skip')

  let rewrite = edgeResponse.headers.get('x-middleware-rewrite')
  let redirect = edgeResponse.headers.get('location')
  let nextRedirect = edgeResponse.headers.get('x-nextjs-redirect')

  // Data requests (i.e. requests for /_next/data ) need special handling
  const isDataReq = request.headers.has('x-nextjs-data')
  // Data requests need to be normalized to the route path
  if (isDataReq && !redirect && !rewrite && !nextRedirect) {
    const requestUrl = new URL(request.url)
    const normalizedDataUrl = normalizeDataUrl(requestUrl.pathname)
    // Don't rewrite unless the URL has changed
    if (normalizedDataUrl !== requestUrl.pathname) {
      rewrite = `${normalizedDataUrl}${requestUrl.search}`
      logger.withFields({ rewrite_url: rewrite }).debug('Rewritten data URL')
    }
  }

  if (rewrite) {
    logger.withFields({ rewrite_url: rewrite }).debug('Found middleware rewrite')

    const rewriteUrl = new URL(rewrite, request.url)
    const baseUrl = new URL(request.url)
    if (rewriteUrl.toString() === baseUrl.toString()) {
      logger.withFields({ rewrite_url: rewrite }).debug('Rewrite url is same as original url')
      return
    }

    const relativeUrl = relativizeURL(rewrite, request.url)

    if (isDataReq) {
      // Data requests might be rewritten to an external URL
      // This header tells the client router the redirect target, and if it's external then it will do a full navigation

      edgeResponse.headers.set('x-nextjs-rewrite', relativeUrl)
    }

    if (rewriteUrl.origin !== baseUrl.origin) {
      logger.withFields({ rewrite_url: rewrite }).debug('Rewriting to external url')
      const proxyRequest = await cloneRequest(rewriteUrl, request)

      // Remove Netlify internal headers
      for (const key of request.headers.keys()) {
        if (key.startsWith('x-nf-')) {
          proxyRequest.headers.delete(key)
        }
      }

      return addMiddlewareHeaders(fetch(proxyRequest, { redirect: 'manual' }), edgeResponse)
    }

    if (isDataReq) {
      rewriteUrl.pathname = rewriteDataPath({
        dataUrl: new URL(request.url).pathname,
        newRoute: removeBasePath(rewriteUrl.pathname, nextConfig?.basePath),
        basePath: nextConfig?.basePath,
      })
    } else {
      // respect trailing slash rules to prevent 308s
      rewriteUrl.pathname = normalizeTrailingSlash(rewriteUrl.pathname, nextConfig?.trailingSlash)
    }

    const target = normalizeLocalizedTarget({ target: rewriteUrl.toString(), request, nextConfig })
    if (target === request.url) {
      logger.withFields({ rewrite_url: rewrite }).debug('Rewrite url is same as original url')
      return
    }
    edgeResponse.headers.set('x-middleware-rewrite', relativeUrl)
    request.headers.set('x-middleware-rewrite', target)

    // coookies set in middleware need to be available during the lambda request
    const newRequest = await cloneRequest(target, request)
    const newRequestCookies = mergeMiddlewareCookies(edgeResponse, newRequest)
    if (newRequestCookies) {
      newRequest.headers.set('Cookie', newRequestCookies)
    }

    return addMiddlewareHeaders(context.next(newRequest), edgeResponse)
  }

  if (redirect) {
    redirect = normalizeLocalizedTarget({ target: redirect, request, nextConfig })
    if (redirect === request.url) {
      logger.withFields({ redirect_url: redirect }).debug('Redirect url is same as original url')
      return
    }
    edgeResponse.headers.set('location', relativizeURL(redirect, request.url))
  }

  // Data requests shouldn't automatically redirect in the browser (they might be HTML pages): they're handled by the router
  if (redirect && isDataReq) {
    edgeResponse.headers.delete('location')
    edgeResponse.headers.set('x-nextjs-redirect', relativizeURL(redirect, request.url))
  }

  nextRedirect = edgeResponse.headers.get('x-nextjs-redirect')

  if (nextRedirect && isDataReq) {
    edgeResponse.headers.set('x-nextjs-redirect', normalizeDataUrl(nextRedirect))
  }

  if (edgeResponse.headers.get('x-middleware-next') === '1') {
    edgeResponse.headers.delete('x-middleware-next')

    // coookies set in middleware need to be available during the lambda request
    const newRequest = await cloneRequest(request.url, request)
    const newRequestCookies = mergeMiddlewareCookies(edgeResponse, newRequest)
    if (newRequestCookies) {
      newRequest.headers.set('Cookie', newRequestCookies)
    }

    return addMiddlewareHeaders(context.next(newRequest), edgeResponse)
  }

  return edgeResponse
}

/**
 * Normalizes the locale in a URL.
 */
function normalizeLocalizedTarget({
  target,
  request,
  nextConfig,
}: {
  target: string
  request: Request
  nextConfig?: RequestData['nextConfig']
}): string {
  const targetUrl = new URL(target, request.url)

  const normalizedTarget = normalizeLocalePath(targetUrl.pathname, nextConfig?.i18n?.locales)

  if (
    normalizedTarget.detectedLocale &&
    !normalizedTarget.pathname.startsWith(`/api/`) &&
    !normalizedTarget.pathname.startsWith(`/_next/static/`)
  ) {
    targetUrl.pathname =
      addBasePath(
        `/${normalizedTarget.detectedLocale}${normalizedTarget.pathname}`,
        nextConfig?.basePath,
      ) || `/`
  } else {
    targetUrl.pathname = addBasePath(normalizedTarget.pathname, nextConfig?.basePath) || `/`
  }
  return targetUrl.toString()
}

async function cloneRequest(url, request: Request) {
  // This is not ideal, but streaming to an external URL doesn't work
  const body = request.body && !request.bodyUsed ? await request.arrayBuffer() : undefined
  return new Request(url, {
    headers: request.headers,
    method: request.method,
    body,
  })
}
