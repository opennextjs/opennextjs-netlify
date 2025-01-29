import {
  createRequestContext,
  runWithRequestContext,
} from './.netlify/dist/run/handlers/request-context.cjs'
import serverHandler from './.netlify/dist/run/handlers/server.js'
import { getTracer } from './.netlify/dist/run/handlers/tracer.cjs'
import tracing from './.netlify/dist/run/handlers/tracing.js'

// Set feature flag for regional blobs
process.env.USE_REGIONAL_BLOBS = '{{useRegionalBlobs}}'

export default async function handler(req, context) {
  if (process.env.NETLIFY_OTLP_TRACE_EXPORTER_URL) {
    tracing.start()
  }
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
        monorepo: false,
        cwd: process.cwd(),
      })
      const response = await serverHandler(req, context)
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
  excludedPath: [
    // We use `preferStatic: true` so we already won't run this on *existing* static assets,
    // but by excluding this entire path we also avoid invoking the function just to 404.
    '/_next/static/*',
  ],
}
