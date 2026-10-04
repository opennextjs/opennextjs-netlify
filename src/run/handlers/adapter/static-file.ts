// Static outputs reached through the function (a rewrite landed on one): Pages HTML from blobs,
// everything else proxied from the CDN.
import { proxyExternalRewrite } from '../../../adapter-runtime-shared/proxy-external-rewrite.js'
import type { HtmlBlob } from '../../../shared/blob-types.cjs'
import { getMemoizedKeyValueStoreBackedByRegionalBlobStore } from '../../storage/storage.cjs'

import type { StaticFileHandlerArg } from './manifest.js'
import type { Produced, ProduceRequest } from './types.js'

export async function serverStaticFile(
  { filePath, pathname }: StaticFileHandlerArg,
  { request }: ProduceRequest,
): Promise<Produced> {
  // only static HTML pages live in blobs (copyStaticContent), every other static output is on the
  // CDN (copyStaticAssets). A request for the file itself never reaches the function then, so
  // getting here means a rewrite landed on it: fetch it from the CDN.
  const [, pagesBlobKey] = filePath.split('/server/pages/')
  if (!pagesBlobKey) {
    if (new URL(request.url).pathname === pathname) {
      // the CDN doesn't have it either (see copyStaticAssets), don't loop through it
      return { kind: 'final', response: new Response('Not Found', { status: 404 }) }
    }
    return {
      kind: 'final',
      response: await proxyExternalRewrite(new URL(pathname, request.url), request),
    }
  }

  const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore()
  const htmlFile = await cacheStore.get<HtmlBlob>(pagesBlobKey, 'staticHtml.get')

  if (!htmlFile) {
    return { kind: 'final', response: new Response('Not found static file', { status: 404 }) }
  }

  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' })
  // Next appends this to any response to a flight request, Pages Router included, "to avoid
  // caching issues when navigating between pages and app" (`base-server` `setVaryHeader`). This
  // handler answers from stored HTML without going through a route module, so do it here too.
  if (request.headers.has('rsc')) {
    headers.set(
      'vary',
      'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
    )
  }
  return {
    kind: 'static-page',
    response: new Response(htmlFile.html, { headers, status: 200 }),
    fullyStatic: Boolean(htmlFile.isFullyStaticPage),
  }
}
