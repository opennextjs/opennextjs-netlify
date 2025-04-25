import {
  createRequestContext,
  runWithRequestContext,
} from '{{cwd}}/.netlify/dist/run/handlers/request-context.cjs'
import { getTracer } from '{{cwd}}/.netlify/dist/run/handlers/tracer.cjs'

process.chdir('{{cwd}}')

// Set feature flag for regional blobs
process.env.USE_REGIONAL_BLOBS = '{{useRegionalBlobs}}'

let cachedHandler
export default async function (req, context) {
  const requestContext = createRequestContext(req, context)
  const tracer = getTracer()

  const handlerResponse = await runWithRequestContext(requestContext, () => {
    return tracer.withActiveSpan('Next.js Server Handler', async (span) => {
      span.setAttributes({
        'account.id': context.account.id,
        'deploy.id': context.deploy.id,
        'request.id': context.requestId,
        'site.id': context.site.id,
        'http.method': req.method,
        'http.target': req.url,
        isBackgroundRevalidation: requestContext.isBackgroundRevalidation,
        monorepo: true,
        cwd: '{{cwd}}',
      })
      if (!cachedHandler) {
        const { default: handler } = await import('{{nextServerHandler}}')
        cachedHandler = handler
      }
      const response = await cachedHandler(req, context, span, requestContext)
      span.setAttributes({
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
