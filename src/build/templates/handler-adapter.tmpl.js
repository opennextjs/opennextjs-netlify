import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import {
  setupHoneycombTracing,
  withHoneycombTracing,
} from '{{runtimeModulesDir}}/dist/adapter-runtime-shared/honeycomb-tracing.js'
import {
  toFetchRequest,
  writeResponse,
} from '{{runtimeModulesDir}}/dist/run/fetch-api-to-req-res.js'
import {
  createRequestContext,
  runWithRequestContext,
} from '{{runtimeModulesDir}}/dist/run/handlers/request-context.cjs'
import serverHandler from '{{runtimeModulesDir}}/dist/run/handlers/server-adapter.js'
import { getTracer, withActiveSpan } from '{{runtimeModulesDir}}/dist/run/handlers/tracer.cjs'

// eslint-disable-next-line no-constant-condition
if ('{{cwd}}' && '{{cwd}}' !== '.') {
  process.chdir('{{cwd}}')
}

// Set feature flag for regional blobs
process.env.USE_REGIONAL_BLOBS = '{{useRegionalBlobs}}'

await setupHoneycombTracing('next-runtime-function', {
  ...JSON.parse(Buffer.from('{{honeycombBuildConfig}}', 'base64').toString()),
  // what Next does after an app's instrumentation registers a provider: spans start outside the
  // prerender's scope, or their random ids and timestamps abort Cache Components prerenders
  afterRegistration: () =>
    createRequire(join(process.cwd(), 'package.json'))(
      'next/dist/server/lib/router-utils/instrumentation-node-extensions.js',
    ).afterRegistration(),
})

export default (req, context) =>
  withHoneycombTracing(req, context.waitUntil?.bind(context), () => handler(req, context))

// Netlify Server (`netlify/server/`): the context comes from the request store
export const listener = (nodeReq, res) => {
  const { context } = globalThis.Netlify
  const req = toFetchRequest(nodeReq, context.url)
  withHoneycombTracing(req, context.waitUntil.bind(context), () =>
    handler(req, context, { req: nodeReq, res }),
  ).catch((error) => {
    console.error('Netlify Server handler error', error)
    if (res.headersSent) {
      res.destroy(error)
    } else {
      res.writeHead(500).end('Internal Server Error')
    }
  })
}

async function handler(req, context, node) {
  const requestContext = createRequestContext(req, context)
  const tracer = getTracer()

  if (node) {
    // whoever sends the response, Next or `writeResponse` below
    const writeHead = node.res.writeHead.bind(node.res)
    node.res.writeHead = (...args) => {
      if (requestContext.serverTiming) {
        node.res.setHeader('server-timing', requestContext.serverTiming)
      }
      return writeHead(...args)
    }
  }

  const handlerResponse = await runWithRequestContext(requestContext, () => {
    return withActiveSpan(tracer, 'Next.js Server Handler', async (span) => {
      span?.setAttributes({
        'account.id': context.account.id,
        'deploy.id': context.deploy.id,
        'request.id': context.requestId,
        'site.id': context.site.id,
        'http.method': req.method,
        'http.target': req.url,
        isBackgroundRevalidation: requestContext.isBackgroundRevalidation,
        cwd: '{{cwd}}',
      })
      const response = await serverHandler(req, requestContext, node)
      span?.setAttributes({
        'http.status_code': response?.status ?? node.res.statusCode,
      })
      return response
    })
  })

  if (node) {
    if (handlerResponse) {
      await writeResponse(handlerResponse, node.res)
    }
    return
  }

  if (requestContext.serverTiming) {
    handlerResponse.headers.set('server-timing', requestContext.serverTiming)
  }

  return handlerResponse
}

export const config = {
  path: '/*',
  preferStatic: true,
}
