import type { Context } from '@netlify/edge-functions'

import matchers from './matchers.json' with { type: 'json' }
import nextConfig from './next.config.json' with { type: 'json' }

import { InternalHeaders } from './lib/headers.ts'
import { logger, LogLevel } from './lib/logging.ts'
import { buildNextRequest, localizeRequest, RequestData } from './lib/next-request.ts'
import { buildResponse, FetchEventResult } from './lib/response.ts'
import {
  getMiddlewareRouteMatcher,
  searchParamsToUrlQuery,
  type MiddlewareRouteMatch,
} from './lib/routing.ts'

type NextHandler = (params: { request: RequestData }) => Promise<FetchEventResult>

const matchesMiddleware: MiddlewareRouteMatch = getMiddlewareRouteMatcher(matchers || [])

/**
 * Runs a Next.js middleware as a Netlify Edge Function. It translates a web
 * platform Request into a NextRequest instance on the way in, and translates
 * a NextResponse into a web platform Response on the way out.
 *
 * @param request Incoming request
 * @param context Netlify-specific context object
 * @param nextHandler Next.js middleware handler
 */
export async function handleMiddleware(
  request: Request,
  context: Context,
  nextHandler: NextHandler,
) {
  const url = new URL(request.url)

  const reqLogger = logger
    .withLogLevel(
      request.headers.has(InternalHeaders.NFDebugLogging) ? LogLevel.Debug : LogLevel.Log,
    )
    .withFields({ url_path: url.pathname })
    .withRequestID(request.headers.get(InternalHeaders.NFRequestID))

  const { localizedUrl } = localizeRequest(url, nextConfig)
  // While we have already checked the path when mapping to the edge function,
  // Next.js supports extra rules that we need to check here too, because we
  // might be running an edge function for a path we should not. If we find
  // that's the case, short-circuit the execution.
  if (
    !matchesMiddleware(localizedUrl.pathname, request, searchParamsToUrlQuery(url.searchParams))
  ) {
    reqLogger.debug('Aborting middleware due to runtime rules')

    return
  }

  const nextRequest = buildNextRequest(request, context, nextConfig)
  try {
    const result = await nextHandler({ request: nextRequest })
    const response = await buildResponse({
      context,
      logger: reqLogger,
      request,
      result,
      nextConfig,
    })

    return response
  } catch (error) {
    console.error(error)

    return new Response(error.message, { status: 500 })
  }
}
