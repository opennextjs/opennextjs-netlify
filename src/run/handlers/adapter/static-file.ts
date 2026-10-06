// Static outputs reached through the function (routing landed on one): proxied from the CDN.
import { encodeRouteBrackets } from '../../../adapter-runtime-shared/next-routing.js'
import { proxyExternalRewrite } from '../../../adapter-runtime-shared/proxy-external-rewrite.js'

import type { StaticFileHandlerArg } from './manifest.js'
import type { Produced, ProduceRequest } from './types.js'

export async function serverStaticFile(
  { pathname }: StaticFileHandlerArg,
  { request }: ProduceRequest,
): Promise<Produced> {
  // Every static output is on the CDN (copyStaticAssets). A request for the file itself never
  // reaches the function, so getting here means routing landed on it (a rewrite, the default
  // locale, an error page): fetch it from the CDN.
  if (new URL(request.url).pathname === pathname) {
    // the CDN doesn't have it either (see copyStaticAssets), don't loop through it
    return { kind: 'final', response: new Response('Not Found', { status: 404 }) }
  }
  const response = await proxyExternalRewrite(
    new URL(encodeRouteBrackets(pathname), request.url),
    request,
  )
  // Next appends this to any response to a flight request, Pages Router included, "to avoid
  // caching issues when navigating between pages and app" (`base-server` `setVaryHeader`)
  if (request.headers.has('rsc') && response.headers.get('content-type')?.startsWith('text/html')) {
    response.headers.set(
      'vary',
      'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
    )
  }
  // a static output can't change within a deploy, so the proxied copy is cached like the file
  return { kind: 'static-page', response, fullyStatic: true }
}
