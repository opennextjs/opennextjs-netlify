import { toComputeResponse, toReqRes } from '@fastly/http-compute-js'
import { HeadersSentEvent } from '@fastly/http-compute-js/dist/http-compute-js/http-outgoing.js'
import type { NextConfigComplete } from 'next/dist/server/config-shared.js'
import type { WorkerRequestHandler } from 'next/dist/server/lib/types.js'
import { TagsManifest, getTagsManifest } from '../config.js'
import { setCacheControlHeaders, setCacheTagsHeaders, setVaryHeaders } from '../headers.js'
import { nextResponseProxy } from '../revalidate.js'

let nextHandler: WorkerRequestHandler, nextConfig: NextConfigComplete, tagsManifest: TagsManifest

export default async (request: Request) => {
  if (!nextHandler) {
    // set the server config
    const { getRunConfig, setRunConfig } = await import('../config.js')
    nextConfig = await getRunConfig()
    setRunConfig(nextConfig)
    tagsManifest = await getTagsManifest()

    const { getMockedRequestHandlers } = await import('./next.cjs')
    ;[nextHandler] = await getMockedRequestHandlers({
      port: 3000,
      hostname: 'localhost',
      dir: process.cwd(),
      isDev: false,
    })
  }

  const { req, res } = toReqRes(request)

  const resProxy = nextResponseProxy(res)

  resProxy.prependListener('_headersSent', (event: HeadersSentEvent) => {
    const headers = new Headers(event.headers)
    setCacheControlHeaders(headers)
    setCacheTagsHeaders(headers, request, tagsManifest)
    setVaryHeaders(headers, request, nextConfig)
    event.headers = Object.fromEntries(headers.entries())
    // console.log('Modified response headers:', JSON.stringify(event.headers, null, 2))
  })

  // temporary workaround for https://linear.app/netlify/issue/ADN-111/
  delete req.headers['accept-encoding']

  try {
    // console.log('Next server request:', req.url)
    await nextHandler(req, resProxy)
  } catch (error) {
    console.error(error)
    resProxy.statusCode = 500
    resProxy.end('Internal Server Error')
  }

  // log the response from Next.js
  const response = {
    headers: resProxy.getHeaders(),
    statusCode: resProxy.statusCode,
  }
  // console.log('Next server response:', JSON.stringify(response, null, 2))

  return toComputeResponse(resProxy)
}