import {
  createRequestContext,
  runWithRequestContext,
} from './.netlify/dist/run/handlers/request-context.cjs'
import serverHandler from './.netlify/dist/run/handlers/server-adapter.js'
import { getTracer, withActiveSpan } from './.netlify/dist/run/handlers/tracer.cjs'

// eslint-disable-next-line no-constant-condition
if ('{{cwd}}') {
  process.chdir('{{cwd}}')
}

// Set feature flag for regional blobs
process.env.USE_REGIONAL_BLOBS = '{{useRegionalBlobs}}'

export default async function handler(req, context) {
  const requestContext = createRequestContext(req, context)
  const tracer = getTracer()

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
      const response = await serverHandler(req, requestContext)
      span?.setAttributes({
        'http.status_code': response.status,
      })
      return response
    })
  })

  if (requestContext.serverTiming) {
    handlerResponse.headers.set('server-timing', requestContext.serverTiming)
  }

  return handlerResponse
}

export const config = {
  path: '/*',
  preferStatic: true,
}
