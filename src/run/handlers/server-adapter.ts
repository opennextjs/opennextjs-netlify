import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'

import type { NextConfigRuntime } from 'next-with-adapters/dist/server/config-shared.js'
import type { RouterServerContext } from 'next-with-adapters/dist/server/lib/router-utils/router-server-context.js'

import { getAdapterManifest, getRunConfig, setRunConfig } from '../config.js'
import { toComputeResponse, toReqRes } from '../fetch-api-to-req-res.js'
import {
  adjustDateHeader,
  setCacheControlHeaders,
  setCacheStatusHeader,
  setCacheTagsHeaders,
  setVaryHeaders,
} from '../headers.js'
import { resolveRoutes } from '../routing.cjs'
import type { ResolveRoutesParams, ResolveRoutesResult } from '../routing.cjs'
import { setFetchBeforeNextPatchedIt } from '../storage/storage.cjs'

import type { RequestContext } from './request-context.cjs'
import { getLogger } from './request-context.cjs'
import { getTracer, withActiveSpan } from './tracer.cjs'
import { configureUseCacheHandlers } from './use-cache-handler.js'
import { setupWaitUntil } from './wait-until.cjs'

// Read the adapter manifest written at build time (same path resolution as getRunConfig)
let manifest: Awaited<ReturnType<typeof getAdapterManifest>>
try {
  manifest = await getAdapterManifest()
} catch (error) {
  console.error('Failed to load adapter manifest', error)
  throw error
}

// make use of global fetch before Next.js applies any patching
setFetchBeforeNextPatchedIt(globalThis.fetch)
// configure globals that Next.js make use of before we start importing any Next.js code
// as some globals are consumed at import time
const { nextConfig: initialNextConfig, enableUseCacheHandler } = await getRunConfig()
if (enableUseCacheHandler) {
  configureUseCacheHandlers()
}
const nextConfig = setRunConfig(initialNextConfig) as unknown as NextConfigRuntime
setupWaitUntil()

// Next.js checks globalThis.AsyncLocalStorage to decide whether to use real
// or fake (throwing) AsyncLocalStorage. Must be set before any Next.js code loads
// (the dynamic import() of route entrypoints happens at request time, after this).
if (!('AsyncLocalStorage' in globalThis)) {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.AsyncLocalStorage = AsyncLocalStorage
}

const RouterServerContextSymbol = Symbol.for('@next/router-server-methods')
const globalThisWithRouterServerContext = globalThis as typeof globalThis & {
  [RouterServerContextSymbol]?: RouterServerContext
}

if (!globalThisWithRouterServerContext[RouterServerContextSymbol]) {
  globalThisWithRouterServerContext[RouterServerContextSymbol] = {
    // TODO(adapter): monorepo?
    '': {
      nextConfig,
    },
  }
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
const nodeHandlerCache = new Map<string, NodeHandlerFn>()

function preferDefault(mod: unknown): unknown {
  return mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod
}

async function loadHandler(filePath: string): Promise<NodeHandlerFn> {
  // Resolve relative paths against process.cwd() (set by handler template)
  const resolvedPath = resolve(filePath)
  const cached = nodeHandlerCache.get(resolvedPath)
  if (cached) {
    return cached
  }
  // eslint-disable-next-line import/no-dynamic-require
  const mod = await import(resolvedPath)
  // Handle both ESM default exports and CJS module.exports (which can
  // result in double-nested .default when imported from ESM)
  const { handler } = preferDefault(preferDefault(mod)) as { handler: NodeHandlerFn }
  nodeHandlerCache.set(resolvedPath, handler)
  return handler
}

// grabbed from Reference AWS Adapter
function applyResolutionToResponse(
  response: Response,
  resolution: ResolveRoutesResult,
  explicitStatus?: number,
): Response {
  const headers = new Headers(response.headers)
  const hasExplicitCacheControl = headers.has('cache-control')
  if (resolution.resolvedHeaders) {
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      const normalizedKey = key.toLowerCase()
      if (normalizedKey === 'cache-control' && hasExplicitCacheControl) {
        continue
      }
      headers.set(key, value)
    }
  }

  return new Response(response.body, {
    status: explicitStatus ?? resolution.status ?? response.status,
    statusText: response.statusText,
    headers,
  })
}

// grabbed from Reference AWS Adapter
function isRedirectResolution(resolution: ResolveRoutesResult): boolean {
  if (!resolution.status) return false
  if (resolution.status < 300 || resolution.status >= 400) return false
  return Boolean(resolution.resolvedHeaders?.get('location'))
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

    // TODO(adapter): what's up with resolution.resolvedHeaders
    // They contain request headers, but also response headers ...

    console.log({ resolution })

    if (resolution.redirect) {
      // Handle explicit redirect
      const { url: redirectUrl, status } = resolution.redirect
      // TODO(adapter): this can be cached forever
      // but we would need to collect routing rules that were involved and inspect them as rules might rely on headers or other request properties,
      // which would require setting correct netlify-vary header.
      return new Response(null, {
        status,
        headers: { location: redirectUrl.toString() },
      })
    }

    // Handle external rewrite
    if (resolution.externalRewrite) {
      try {
        const proxyRequest = new Request(resolution.externalRewrite.toString(), request)
        // Remove Netlify internal headers
        for (const key of request.headers.keys()) {
          if (key.startsWith('x-nf-')) {
            proxyRequest.headers.delete(key)
          }
        }

        const fetchResp = await fetch(proxyRequest, { redirect: 'manual' })
        // fetch() returns immutable headers — create a new Response with mutable headers
        const headers = new Headers(fetchResp.headers)
        // fetch() transparently decompresses the body but keeps the original
        // content-encoding/transfer-encoding headers. Strip them so the browser
        // doesn't try to decompress an already-decompressed body.
        headers.delete('transfer-encoding')
        headers.delete('content-encoding')
        headers.delete('content-length')
        return new Response(fetchResp.body, {
          ...fetchResp,
          headers,
        })
      } catch (error) {
        console.error('external rewrite fetch error', error)
        getLogger().withError(error).error('external rewrite fetch error')
        return new Response('Bad Gateway', { status: 502 })
      }
    }

    if (isRedirectResolution(resolution)) {
      // TODO(adapter): this can be cached forever
      // but we would need to collect routing rules that were involved and inspect them as rules might rely on headers or other request properties,
      // which would require setting correct netlify-vary header.
      return applyResolutionToResponse(
        new Response(null, { status: resolution.status }),
        resolution,
        resolution.status,
      )
    }

    // Handle matched route
    if (resolution.matchedPathname) {
      const matchedOutput = outputsByPathname.get(resolution.matchedPathname)
      if (!matchedOutput) {
        return new Response('Routing matched but no matched output exists', { status: 500 })
      }

      if (matchedOutput.runtime !== 'nodejs') {
        return new Response(`Not yet supported runtime ${matchedOutput.runtime}`, { status: 500 })
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
          const nextHandlerPromise = handler(req, res, {
            waitUntil: requestContext.trackBackgroundWork,
          })

          // below is for now copied from standalone handler (without some extras, that generally could also be removed from standalone)
          // but will be nice to extract common handling to shared module and cleanup some things

          // Contrary to the docs, this resolves when the headers are available, not when the stream closes.
          // See https://github.com/fastly/http-compute-js/blob/main/src/http-compute-js/http-server.ts#L168-L173
          const response = await toComputeResponse(res)

          invokeSpan?.setAttribute('http.status_code', response.status)

          const nextCache = response.headers.get('x-nextjs-cache')
          const isServedFromNextCache = nextCache === 'HIT' || nextCache === 'STALE'

          if (isServedFromNextCache) {
            await adjustDateHeader({
              headers: response.headers,
              request,
              span,
              requestContext,
            })
          }
          setCacheControlHeaders(response, request, requestContext)
          setCacheTagsHeaders(response.headers, requestContext)
          setVaryHeaders(
            response.headers,
            request,
            manifest.config as Parameters<typeof setVaryHeaders>[2],
          )
          setCacheStatusHeader(response.headers, nextCache)

          // eslint-disable-next-line no-inner-declarations
          async function waitForBackgroundWork() {
            // it's important to keep the stream open until the next handler has finished
            await nextHandlerPromise

            // Next.js relies on `close` event emitted by response to trigger running callback variant of `next/after`
            // however @fastly/http-compute-js never actually emits that event - so we have to emit it ourselves,
            // otherwise Next would never run the callback variant of `next/after`
            res.emit('close')

            // We have to keep response stream open until tracked background promises that are don't use `context.waitUntil`
            // are resolved. If `context.waitUntil` is available, `requestContext.backgroundWorkPromise` will be empty
            // resolved promised and so awaiting it is no-op
            await requestContext.backgroundWorkPromise
          }

          const keepOpenUntilNextFullyRendered = new TransformStream({
            async flush() {
              await waitForBackgroundWork()
            },
          })

          if (!response.body) {
            await waitForBackgroundWork()
          }

          return new Response(response.body?.pipeThrough(keepOpenUntilNextFullyRendered), response)
        } catch (error) {
          console.error('route handler error', error)
          getLogger().withError(error).error('route handler error')
          invokeSpan?.setAttribute('http.status_code', 500)
          return new Response('Internal Server Error', { status: 500 })
        }
      })
    }

    // No match found — 404
    // TODO(adapter): this can be cached forever because it will never match any routes
    // but we would need to collect routing rules that were involved and inspect them as rules might rely on headers or other request properties,
    // which would require setting correct netlify-vary header.
    return new Response('Not Found', { status: 404 })
  })
}
