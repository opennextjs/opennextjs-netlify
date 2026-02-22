import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'

import { toComputeResponse, toReqRes } from '@fastly/http-compute-js'

import { getAdapterManifest } from '../config.js'
import {
  setCacheControlHeaders,
  setCacheStatusHeader,
  setCacheTagsHeaders,
  setVaryHeaders,
} from '../headers.js'
import { resolveRoutes } from '../routing.cjs'
import type { ResolveRoutesParams, ResolveRoutesResult } from '../routing.cjs'

import type { RequestContext } from './request-context.cjs'
import { getLogger } from './request-context.cjs'
import { getTracer, withActiveSpan } from './tracer.cjs'

// Next.js checks globalThis.AsyncLocalStorage to decide whether to use real
// or fake (throwing) AsyncLocalStorage. Must be set before any Next.js code loads
// (the dynamic import() of route entrypoints happens at request time, after this).
if (!('AsyncLocalStorage' in globalThis)) {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.AsyncLocalStorage = AsyncLocalStorage
}

// Read the adapter manifest written at build time (same path resolution as getRunConfig)
let manifest: Awaited<ReturnType<typeof getAdapterManifest>>
try {
  manifest = await getAdapterManifest()
} catch (error) {
  console.error('Failed to load adapter manifest', error)
  throw error
}

// Build a map of pathname -> output for quick lookup at request time
const outputsByPathname = new Map<string, { filePath: string; runtime: string }>()

for (const output of manifest.outputs.pages) {
  outputsByPathname.set(output.pathname, output)
}
for (const output of manifest.outputs.pagesApi) {
  outputsByPathname.set(output.pathname, output)
}
for (const output of manifest.outputs.appPages) {
  outputsByPathname.set(output.pathname, output)
}
for (const output of manifest.outputs.appRoutes) {
  outputsByPathname.set(output.pathname, output)
}

const allPathnames = [...outputsByPathname.keys()]

type NodeHandlerFn = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx?: { waitUntil?: (prom: Promise<void>) => void },
) => Promise<void>

// Cache loaded handler functions
const handlerCache = new Map<string, NodeHandlerFn>()

function preferDefault(mod: unknown): unknown {
  return mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod
}

async function loadHandler(filePath: string): Promise<NodeHandlerFn> {
  // Resolve relative paths against process.cwd() (set by handler template)
  const resolvedPath = resolve(filePath)
  const cached = handlerCache.get(resolvedPath)
  if (cached) {
    return cached
  }
  // eslint-disable-next-line import/no-dynamic-require
  const mod = await import(resolvedPath)
  // Handle both ESM default exports and CJS module.exports (which can
  // result in double-nested .default when imported from ESM)
  const { handler } = preferDefault(preferDefault(mod)) as { handler: NodeHandlerFn }
  handlerCache.set(resolvedPath, handler)
  return handler
}

export default async (request: Request, requestContext: RequestContext) => {
  const tracer = getTracer()

  return await withActiveSpan(tracer, 'adapter route resolution', async (span) => {
    const url = new URL(request.url)

    let resolution: ResolveRoutesResult
    try {
      resolution = await resolveRoutes({
        url,
        buildId: manifest.buildId,
        basePath: manifest.config.basePath || '',
        requestBody: request.body ?? new ReadableStream(),
        headers: new Headers(request.headers),
        pathnames: allPathnames,
        // Cast i18n config — next-with-adapters uses readonly arrays while @next/routing expects mutable
        i18n: (manifest.config.i18n ?? undefined) as ResolveRoutesParams['i18n'],
        routes: manifest.routing,
        invokeMiddleware: async () => {
          // Middleware runs in Netlify Edge Function before the serverless function.
          // By the time the request reaches this handler, middleware has already executed.
          // Return a no-op result.
          return {}
        },
      })
    } catch (error) {
      console.error('route resolution error', error)
      getLogger().withError(error).error('route resolution error')
      return new Response('Internal Server Error', { status: 500 })
    }

    console.log({ resolution })

    // Handle redirect
    if (resolution.redirect) {
      const { url: redirectUrl, status } = resolution.redirect
      return new Response(null, {
        status,
        headers: { location: redirectUrl.toString() },
      })
    }

    // Handle external rewrite
    if (resolution.externalRewrite) {
      try {
        const externalResponse = await fetch(resolution.externalRewrite.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
          // @ts-expect-error - duplex is needed for streaming request bodies
          duplex: 'half',
        })
        return externalResponse
      } catch (error) {
        console.error('external rewrite fetch error', error)
        getLogger().withError(error).error('external rewrite fetch error')
        return new Response('Bad Gateway', { status: 502 })
      }
    }

    // Handle matched route
    if (resolution.matchedPathname) {
      const matchedOutput = outputsByPathname.get(resolution.matchedPathname)
      if (!matchedOutput) {
        return new Response('Routing matched but no matched output exists', { status: 500 })
      }

      span?.setAttribute('matched.pathname', resolution.matchedPathname)
      span?.setAttribute('matched.filePath', matchedOutput.filePath)

      return await withActiveSpan(tracer, 'invoke route handler', async (invokeSpan) => {
        try {
          const handler = await loadHandler(matchedOutput.filePath)

          // Convert Web Request to Node.js IncomingMessage/ServerResponse
          const { req, res } = toReqRes(request)

          // Invoke the route handler using the Node.js handler signature
          // as defined by the Next.js adapter contract:
          // handler(req: IncomingMessage, res: ServerResponse, ctx)
          await handler(req, res, {
            waitUntil: requestContext.trackBackgroundWork,
          })

          // Convert Node.js ServerResponse back to Web Response
          const response = await toComputeResponse(res)

          invokeSpan?.setAttribute('http.status_code', response.status)

          // Apply Netlify headers
          const nextCache = response.headers.get('x-nextjs-cache')
          setCacheControlHeaders(response, request, requestContext)
          setCacheTagsHeaders(response.headers, requestContext)
          setVaryHeaders(
            response.headers,
            request,
            manifest.config as Parameters<typeof setVaryHeaders>[2],
          )
          setCacheStatusHeader(response.headers, nextCache)

          return response
        } catch (error) {
          console.error('route handler error', error)
          getLogger().withError(error).error('route handler error')
          invokeSpan?.setAttribute('http.status_code', 500)
          return new Response('Internal Server Error', { status: 500 })
        }
      })
    }

    // No match found — 404
    // TODO: this can be cached forever because it will never match any routes
    return new Response('Not Found', { status: 404 })
  })
}
