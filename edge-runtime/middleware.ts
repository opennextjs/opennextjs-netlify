// import type { Context } from '@netlify/edge-functions'

import { InternalHeaders } from './lib/headers.ts'
import { logger, LogLevel } from './lib/logging.ts'
import { buildNextRequest } from './lib/next-request.ts'
import type { NextHandler } from './lib/types.ts'
// import { buildResponse } from './lib/response.ts'

/**
 * Runs a Next.js middleware as a Netlify Edge Function. It translates a web
 * platform Request into a NextRequest instance on the way in, and translates
 * a NextResponse into a web platform Response on the way out.
 *
 * @param request Incoming request
 * @param context Netlify-specific context object
 * @param nextHandler Next.js middleware handler
 */
export async function handleMiddleware(request: Request, nextHandler: NextHandler) {
  const url = new URL(request.url)

  const reqLogger = logger
    .withLogLevel(
      request.headers.has(InternalHeaders.NFDebugLogging) ? LogLevel.Debug : LogLevel.Log,
    )
    .withFields({ url_path: url.pathname })
    .withRequestID(request.headers.get(InternalHeaders.NFRequestID))

  const nextRequest = buildNextRequest(request)
  try {
    const result = await nextHandler({ request: nextRequest })

    return result.response
    // const response = await buildResponse({
    //   logger: reqLogger,
    //   request,
    //   result,
    // })

    // return response
  } catch (error) {
    console.error(error)

    return new Response(error instanceof Error ? error.message : String(error), { status: 500 })
  }
}
