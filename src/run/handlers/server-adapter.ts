import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Span } from '@opentelemetry/api'
import type { AdapterOutput } from 'next-with-adapters'
import type { NextConfigRuntime } from 'next-with-adapters/dist/server/config-shared.js'
import type { RouterServerContext } from 'next-with-adapters/dist/server/lib/router-utils/router-server-context.js'
import type { RequestMeta } from 'next-with-adapters/dist/server/request-meta.js'
import { isDynamicRoute } from 'next-with-adapters/dist/shared/lib/router/utils/is-dynamic.js'
import { getRouteMatcher } from 'next-with-adapters/dist/shared/lib/router/utils/route-matcher.js'
import { getRouteRegex } from 'next-with-adapters/dist/shared/lib/router/utils/route-regex.js'

import {
  addDefaultLocaleForRouting,
  applyResolutionToResponse,
  getPathnameAliases,
  isNextDataPathname,
  preferStaticPathnameAfterRewrite,
  resolveRoutes,
  setNextDataHeader,
} from '../../adapter-runtime-shared/next-routing.js'
import type {
  I18nForRouting,
  ResolveRoutesParams,
  ResolveRoutesResult,
} from '../../adapter-runtime-shared/next-routing.js'
import { proxyExternalRewrite } from '../../adapter-runtime-shared/proxy-external-rewrite.js'
import { HtmlBlob } from '../../shared/blob-types.cjs'
import { getAdapterManifest, getRunConfig, setRunConfig } from '../config.js'
import { PLUGIN_DIR } from '../constants.js'
import { toComputeResponse, toReqRes } from '../fetch-api-to-req-res.js'
import {
  adjustDateHeader,
  setCacheControlHeaders,
  setCacheStatusHeader,
  setCacheTagsHeaders,
  setVaryHeaders,
} from '../headers.js'
import {
  getMemoizedKeyValueStoreBackedByRegionalBlobStore,
  setFetchBeforeNextPatchedIt,
} from '../storage/storage.cjs'

import { invokeEdgeRuntimeOutput } from './edge-runtime-sandbox.js'
import { getRequestContext, type RequestContext } from './request-context.cjs'
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

// Next's server loads .env files at startup, route modules don't. PLUGIN_DIR is the app dir in the
// handler where the .env files were copied to, and @next/env resolves to the app's copy shipped there.
// @next/env is CommonJS, so the named export is only there when cjs-module-lexer detects it
const nextEnv =
  // eslint-disable-next-line import/no-extraneous-dependencies, import/max-dependencies, n/no-extraneous-import
  (await import('@next/env')) as typeof import('@next/env') & {
    default?: typeof import('@next/env')
  }
;(nextEnv.default ?? nextEnv).loadEnvConfig(PLUGIN_DIR, false)

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

type CommonHandlerArg = {
  request: Request
  requestContext: RequestContext
  resolution: ResolveRoutesResult
  tracer: ReturnType<typeof getTracer>
  span?: Span
  // set when rendering the error page for this status (like Next's router does with res.statusCode)
  invokeStatus?: number
}

type Handler = (requestArgs: CommonHandlerArg) => Promise<Response> | Response

// Build a map of pathname -> handler output for quick lookup at request time
const handlerDefsByPathname = new Map<string, Handler>()
const handlerDefsId = new Map<string, Handler>()
const basePath = manifest.config.basePath || ''
const routingBasics = { basePath, buildId: manifest.buildId }
function registerHandler(pathname: string, handler: Handler) {
  for (const alias of getPathnameAliases(pathname, basePath)) {
    handlerDefsByPathname.set(alias, handler)
  }
}

type InvokeHandlerArg = {
  id: string
  entrypoint: string
  runtime: 'nodejs' | 'edge'
  sourcePage: string
  pathname: string
  isAppRoute: boolean
}

const appRouteIds = new Set(manifest.outputs.appRoutes.map((output) => output.id))

// pages with getStaticProps: prerenders point back at them, their data-route outputs share the
// sourcePage
const ssgParentIds = new Set(manifest.outputs.prerenders.map((output) => output.parentOutputId))
const ssgSourcePages = new Set(
  manifest.outputs.pages
    .filter((output) => ssgParentIds.has(output.id))
    .map((output) => output.sourcePage),
)
const ssgPathnames = new Set<string>()

function createInvokeHandler(
  output:
    | AdapterOutput['PAGES']
    | AdapterOutput['PAGES_API']
    | AdapterOutput['APP_PAGE']
    | AdapterOutput['APP_ROUTE'],
): Handler {
  return invokeHandler.bind(null, {
    id: output.id,
    entrypoint: output.filePath,
    runtime: output.runtime,
    sourcePage: output.sourcePage,
    pathname: output.pathname,
    isAppRoute: appRouteIds.has(output.id),
  })
}

// outputs that invoke compute
for (const output of [
  ...manifest.outputs.pages,
  ...manifest.outputs.pagesApi,
  ...manifest.outputs.appPages,
  ...manifest.outputs.appRoutes,
]) {
  const handler = createInvokeHandler(output)
  handlerDefsId.set(output.id, handler)
  registerHandler(output.pathname, handler)
  if (ssgSourcePages.has(output.sourcePage)) {
    for (const alias of getPathnameAliases(output.pathname, basePath)) {
      ssgPathnames.add(alias)
    }
  }
}

for (const output of manifest.outputs.prerenders) {
  const parentHandler = handlerDefsId.get(output.parentOutputId)
  if (!parentHandler) {
    throw new Error(
      `Prerender output ${output.id} has parentOutputId ${output.parentOutputId} which does not exist`,
    )
  }
  registerHandler(output.pathname, parentHandler)
  for (const alias of getPathnameAliases(output.pathname, basePath)) {
    ssgPathnames.add(alias)
  }
}

// serve static files
type StaticFileHandlerArg = {
  filePath: string
}
function createStaticFileHandler(output: StaticFileHandlerArg): Handler {
  return serverStaticFile.bind(null, output)
}

const staticFilePathnames = new Set<string>()
for (const output of manifest.outputs.staticFiles) {
  for (const alias of getPathnameAliases(output.pathname, basePath)) {
    staticFilePathnames.add(alias)
  }
  registerHandler(output.pathname, createStaticFileHandler({ filePath: output.filePath }))
}

const allPathnames = [...handlerDefsByPathname.keys()]

type NodeHandlerFn = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx?: { waitUntil?: (prom: Promise<void>) => void; requestMeta?: RequestMeta },
) => Promise<void>

// Next.js machinery, see next/dist/server/lib/router-utils/router-server-context.js
// Route modules read their `nextConfig` from here (keyed by relativeProjectDir), same as next-server does.
const RouterServerContextSymbol = Symbol.for('@next/router-server-methods')

// Netlify Adapter machinery (just for integration tests resetting global state in-between tests)
// TODO(adapter): figure out something better, we should not expose test-only globals in the actual adapter code
const NetlifyAdapterTestReset = Symbol.for('@netlify/adapter-test-reset')

// Cache loaded handler functions
const nodeHandlerCache = new Map<string, NodeHandlerFn>()

const extendedGlobalThis = globalThis as typeof globalThis & {
  [RouterServerContextSymbol]?: RouterServerContext

  // just for reset in-between tests, see tests/utils/fixture.ts
  [NetlifyAdapterTestReset]: () => void
}

extendedGlobalThis[RouterServerContextSymbol] = {
  [manifest.relativeProjectDir]: {
    nextConfig,
  },
}

/**
 * Custom error page for the request, like Next's router: 404 renders pages router `/404` (locale
 * variant first), else app router `/_not-found`; 500 renders `/500`, else `/_error`. Static error
 * HTML is served with Next's default headers for error pages rather than the permanent caching a
 * direct request to a fully static page gets.
 */
async function renderErrorPage(
  status: 404 | 500,
  { request, requestContext, tracer, span }: Omit<CommonHandlerArg, 'resolution'>,
): Promise<Response> {
  const url = new URL(request.url)
  const candidates: string[] = []
  if (manifest.config.i18n) {
    const { locales, defaultLocale } = manifest.config.i18n
    const segment = url.pathname.slice(basePath.length).split('/')[1]?.toLowerCase()
    const locale = locales.find((value) => value.toLowerCase() === segment) ?? defaultLocale
    candidates.push(`${basePath}/${locale}/${status}`)
  }
  candidates.push(
    `${basePath}/${status}`,
    status === 404 ? `${basePath}/_not-found` : `${basePath}/_error`,
  )

  const pathname = candidates.find((candidate) => handlerDefsByPathname.has(candidate))
  const handler = pathname ? handlerDefsByPathname.get(pathname) : undefined
  if (!pathname || !handler) {
    return new Response(status === 404 ? 'Not Found' : 'Internal Server Error', { status })
  }

  const response = await handler({
    request: new Request(new URL(pathname, request.url), { headers: request.headers }),
    requestContext,
    resolution: {},
    tracer,
    span,
    invokeStatus: status,
  })

  const headers = new Headers(response.headers)
  if (staticFilePathnames.has(pathname)) {
    headers.delete('netlify-cdn-cache-control')
    headers.set('cache-control', 'private, no-cache, no-store, max-age=0, must-revalidate')
  }
  const errorResponse = new Response(response.body, { status, headers })
  setCacheControlHeaders(errorResponse, request, requestContext)
  return errorResponse
}

// a literal request for the 404 page (or its locale variant) responds with 404, like Next's server
// does, unless it's the on-demand revalidation of that page
function isNotFoundPageRequest(request: Request, resolvedPathname: string): boolean {
  if (request.headers.has('x-prerender-revalidate')) {
    return false
  }
  if (resolvedPathname === `${basePath}/404`) {
    return true
  }
  const locales = manifest.config.i18n?.locales ?? []
  return locales.some((locale) => resolvedPathname === `${basePath}/${locale}/404`)
}

// passed via requestMeta so Next.js renders our custom 404 page for `notFound: true` / `notFound()`
// instead of its bare "This page could not be found" fallback
const render404: NonNullable<RequestMeta['render404']> = async (
  req,
  res,
  _parsedUrl,
  setHeaders,
) => {
  const requestContext = getRequestContext()
  if (!requestContext?.originalRequest) {
    throw new Error('render404 called outside of request context')
  }
  const response = await renderErrorPage(404, {
    request: requestContext.originalRequest,
    requestContext,
    tracer: getTracer(),
  })
  if (!res.headersSent) {
    res.statusCode = 404
    for (const [name, value] of response.headers) {
      if (
        name === 'content-type' ||
        (setHeaders && !['content-length', 'transfer-encoding'].includes(name))
      ) {
        res.setHeader(name, value)
      }
    }
  }
  res.end(Buffer.from(await response.arrayBuffer()))
}

// passed via requestMeta so pages router `res.revalidate()` goes through this handler instead of network
const revalidate: NonNullable<RequestMeta['revalidate']> = async (args) => {
  const { urlPath, headers: revalidateHeaders } = args
  const requestContext = getRequestContext()
  if (!requestContext) {
    throw new Error('revalidate called outside of request context')
  }

  if (!requestContext.originalRequest) {
    throw new Error('original request not set in request context')
  }

  if (!requestContext.originalContext) {
    throw new Error('original context not set in request context')
  }

  const normalizeRevalidateHeaders = new Headers()
  for (const [headerName, headerValueOrValues] of Object.entries(revalidateHeaders)) {
    const headerValues = Array.isArray(headerValueOrValues)
      ? headerValueOrValues
      : [headerValueOrValues]
    for (const headerValue of headerValues) {
      normalizeRevalidateHeaders.append(headerName, headerValue)
    }
  }

  const revalidateRequest = new Request(
    new URL(`${manifest.config.basePath}${urlPath}`, requestContext.originalRequest.url),
    {
      headers: normalizeRevalidateHeaders,
    },
  )

  // ensure to trigger cache-tag revalidation after storing cache entries in cache handler
  requestContext.didPagesRouterOnDemandRevalidate = true
  const revalidatePromise = ServerHandler(revalidateRequest, requestContext)
  requestContext.trackBackgroundWork(revalidatePromise)
  return revalidatePromise
    .catch((revalidateError) => {
      console.error('Revalidation failed', revalidateError)
    })
    .then(() => {
      // no-op
    })
}

extendedGlobalThis[NetlifyAdapterTestReset] = () => {
  nodeHandlerCache.clear()
}

function preferDefault(mod: unknown): unknown {
  return mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod
}

// PLUGIN_DIR is the app dir inside the handler (where `.netlify` lives), output filePaths are relative
// to the handler root
const handlerRootDir = resolvePath(
  PLUGIN_DIR,
  ...manifest.relativeAppDir
    .split('/')
    .filter(Boolean)
    .map(() => '..'),
)

async function loadHandler(filePath: string): Promise<NodeHandlerFn> {
  const resolvedPath = pathToFileURL(resolvePath(handlerRootDir, filePath)).href
  const cached = nodeHandlerCache.get(resolvedPath)
  if (cached) {
    return cached
  }
  // eslint-disable-next-line import/no-dynamic-require
  const mod = await import(resolvedPath)
  const { handler } = (await preferDefault(mod)) as { handler: NodeHandlerFn }
  nodeHandlerCache.set(resolvedPath, handler)
  return handler
}

function isRedirectResolution(resolution: ResolveRoutesResult): boolean {
  if (!resolution.status) return false
  if (resolution.status < 300 || resolution.status >= 400) return false
  return Boolean(resolution.resolvedHeaders?.get('location'))
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function serverStaticFile({ filePath }: StaticFileHandlerArg, _: CommonHandlerArg) {
  const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore()

  // filePath is relative to repoRoot, blobs are keyed relative to <distDir>/server/pages (see copyStaticContent)
  const blobKey = filePath.split('/server/pages/')[1] ?? filePath

  const htmlFile = await cacheStore.get<HtmlBlob>(blobKey, 'staticHtml.get')

  const headers = new Headers()
  let body = 'Not found static file'
  let status = 404

  if (htmlFile) {
    body = htmlFile.html
    status = 200
    headers.set('Content-Type', 'text/html; charset=utf-8')
    if (htmlFile.isFullyStaticPage) {
      // handle CDN Cache Control on fully static pages
      headers.set('cache-control', 'public, max-age=0, must-revalidate')
      headers.set('netlify-cdn-cache-control', 'max-age=31536000, durable')
    }
  }

  return new Response(body, {
    headers,
    status,
  })
}

// Route params for the module. `nxtP` query keys cover matches through `dynamicRoutes`, but a
// middleware rewrite straight to a concrete path of a dynamic page (`/to-ssg → /ssg/hello`) carries
// them nowhere else; Next's router derives them from the invoked path the same way.
const routeMatchers = new Map<string, ReturnType<typeof getRouteMatcher>>()
function getRouteParams(template: string, pathname: string | undefined) {
  if (!pathname || !isDynamicRoute(template)) {
    return
  }
  let matcher = routeMatchers.get(template)
  if (!matcher) {
    matcher = getRouteMatcher(getRouteRegex(template))
    routeMatchers.set(template, matcher)
  }
  let page = pathname
  const dataPrefix = `${basePath}/_next/data/${manifest.buildId}/`
  if (page.startsWith(dataPrefix)) {
    const rest = page.slice(dataPrefix.length).replace(/\.json$/, '')
    page = rest === 'index' ? basePath || '/' : `${basePath}/${rest}`
  }
  const locale = getPathnameLocale(page)
  if (locale) {
    const rest = page.slice(basePath.length)
    page = `${basePath}${rest.slice(locale.length + 1) || '/'}`
  }
  return matcher(page) || undefined
}

function getPathnameLocale(pathname: string): string | undefined {
  if (!manifest.config.i18n) {
    return undefined
  }
  const [, first = ''] = pathname.slice(basePath.length).split('/')
  return manifest.config.i18n.locales.find((value) => value.toLowerCase() === first.toLowerCase())
}

// Next's router detects the locale from the requested path and overrides it with the one of a
// middleware rewrite target; the module only sees req.url (the requested path) so pass it on
function getLocaleRequestMeta(request: Request, resolution: ResolveRoutesResult) {
  if (!manifest.config.i18n) {
    return {}
  }
  const locale =
    (resolution.invocationTarget && getPathnameLocale(resolution.invocationTarget.pathname)) ??
    getPathnameLocale(new URL(request.url).pathname) ??
    manifest.config.i18n.defaultLocale
  return { locale, defaultLocale: manifest.config.i18n.defaultLocale }
}

async function invokeHandler(
  { id, entrypoint, runtime, sourcePage, pathname, isAppRoute }: InvokeHandlerArg,
  { tracer, request, requestContext, resolution, span, invokeStatus }: CommonHandlerArg,
) {
  span?.setAttribute('matched.sourcePage', sourcePage)
  span?.setAttribute('matched.runtime', runtime)
  return await withActiveSpan(tracer, 'invoke route handler', async (invokeSpan) => {
    if (runtime === 'edge') {
      try {
        return await invokeEdgeRuntimeOutput({
          outputId: id,
          request,
          requestContext,
          manifest,
          query: resolution.resolvedQuery,
          routeParams: getRouteParams(pathname, resolution.invocationTarget?.pathname),
        })
      } catch (error) {
        console.error('edge runtime output error', error)
        getLogger().withError(error).error('edge runtime output error')
        invokeSpan?.setAttribute('http.status_code', 500)
        return new Response('Internal Server Error', { status: 500 })
      }
    }

    try {
      const handler = await loadHandler(entrypoint)

      // route handlers (route.ts) read search params from the URL only, so rewrite-added query has
      // nowhere else to travel. Other outputs get it via requestMeta below, keeping req.url public.
      let handlerRequest = request
      if (isAppRoute && resolution.resolvedQuery) {
        const url = new URL(request.url)
        for (const [key, valueOrValues] of Object.entries(resolution.resolvedQuery)) {
          url.searchParams.delete(key)
          for (const value of Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues]) {
            url.searchParams.append(key, value)
          }
        }
        handlerRequest = new Request(url, request)
      }

      // Convert Web Request to Node.js IncomingMessage/ServerResponse
      const { req, res } = toReqRes(handlerRequest)
      if (invokeStatus) {
        res.statusCode = invokeStatus
      }

      // Invoke the route handler using the Node.js handler signature
      // as defined by the Next.js adapter contract:
      // handler(req: IncomingMessage, res: ServerResponse, ctx)
      const nextHandlerPromise = handler(req, res, {
        waitUntil: requestContext.trackBackgroundWork,
        requestMeta: {
          initURL: request.url,
          // rewrite result (with nxtP-prefixed route params), the module re-derives config rewrites
          // from req.url itself but can't know about middleware ones
          query: resolution.resolvedQuery,
          params: getRouteParams(pathname, resolution.invocationTarget?.pathname),
          ...getLocaleRequestMeta(request, resolution),
          render404,
          revalidate,
        },
      })

      // Route modules rethrow render errors for the host to serve the error page (Next's router
      // renders /500 then). Ending the response here also avoids leaving it open until timeout.
      let failedBeforeHeaders = false
      nextHandlerPromise.catch((error) => {
        console.error('route handler error', error)
        if (!res.headersSent) {
          failedBeforeHeaders = true
          res.statusCode = 500
          res.end('Internal Server Error')
        }
      })

      // below is for now copied from standalone handler (without some extras, that generally could also be removed from standalone)
      // but will be nice to extract common handling to shared module and cleanup some things

      // Contrary to the docs, this resolves when the headers are available, not when the stream closes.
      // See https://github.com/fastly/http-compute-js/blob/main/src/http-compute-js/http-server.ts#L168-L173
      const response = await toComputeResponse(res)

      if (failedBeforeHeaders && !invokeStatus) {
        invokeSpan?.setAttribute('http.status_code', 500)
        return renderErrorPage(500, { request, requestContext, tracer, span })
      }

      invokeSpan?.setAttribute('http.status_code', response.status)

      const nextCache = response.headers.get('x-nextjs-cache')
      const isServedFromNextCache = nextCache === 'HIT' || nextCache === 'STALE'

      if (isServedFromNextCache) {
        await adjustDateHeader({
          headers: response.headers,
          request,
          span: invokeSpan,
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
        await nextHandlerPromise.catch(() => {
          // already reported above
        })

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

/**
 * Deserialize a ResolveRoutesResult from the `x-next-route-resolution` header.
 * The routing edge function serializes the resolution as JSON with
 * Headers → plain object, URL → string conversions.
 */
function deserializeResolution(serialized: string): ResolveRoutesResult {
  const parsed = JSON.parse(serialized) as {
    resolvedPathname: string | null
    resolvedQuery: ResolveRoutesResult['resolvedQuery'] | null
    invocationTarget: ResolveRoutesResult['invocationTarget'] | null
    routeMatches: Record<string, string> | null
    resolvedHeaders: Record<string, string> | null
    status: number | null
    redirect: { url: string; status: number } | null
    externalRewrite: string | null
    middlewareResponded: boolean
  }

  const resolution: ResolveRoutesResult = {}

  if (parsed.resolvedPathname !== null) {
    resolution.resolvedPathname = parsed.resolvedPathname
  }
  if (parsed.resolvedQuery !== null) {
    resolution.resolvedQuery = parsed.resolvedQuery
  }
  if (parsed.invocationTarget !== null) {
    resolution.invocationTarget = parsed.invocationTarget
  }
  if (parsed.routeMatches !== null) {
    resolution.routeMatches = parsed.routeMatches
  }
  if (parsed.status !== null) {
    resolution.status = parsed.status
  }
  if (parsed.middlewareResponded) {
    resolution.middlewareResponded = parsed.middlewareResponded
  }
  if (parsed.resolvedHeaders !== null) {
    const headers = new Headers()
    for (const [key, value] of Object.entries(parsed.resolvedHeaders)) {
      headers.set(key, value)
    }
    resolution.resolvedHeaders = headers
  }
  if (parsed.redirect !== null) {
    resolution.redirect = {
      url: new URL(parsed.redirect.url),
      status: parsed.redirect.status,
    }
  }
  if (parsed.externalRewrite !== null) {
    resolution.externalRewrite = new URL(parsed.externalRewrite)
  }

  return resolution
}

export default async function ServerHandler(request: Request, requestContext: RequestContext) {
  const tracer = getTracer()

  return await withActiveSpan(tracer, 'adapter route resolution', async (span) => {
    const url = new URL(request.url)

    let resolution: ResolveRoutesResult

    const serializedResolution = request.headers.get('x-next-route-resolution')
    if (serializedResolution) {
      // Resolution was computed by the routing edge function — skip resolveRoutes
      resolution = deserializeResolution(serializedResolution)
    } else {
      // No edge function (standalone mode fallback, or edge function not deployed)
      try {
        resolution = await resolveRoutes({
          url: addDefaultLocaleForRouting(url, {
            basePath: manifest.config.basePath || '',
            buildId: manifest.buildId,
            i18n: manifest.config.i18n as I18nForRouting | null,
          }),
          buildId: manifest.buildId,
          basePath: manifest.config.basePath || '',
          requestBody: request.body ?? new ReadableStream(),
          headers: setNextDataHeader(new Headers(request.headers), url, routingBasics),
          pathnames: allPathnames,
          // Cast i18n config — next-with-adapters uses readonly arrays while @next/routing expects mutable
          i18n: (manifest.config.i18n ?? undefined) as ResolveRoutesParams['i18n'],
          routes: {
            ...manifest.routing,
            caseSensitive: manifest.config.experimental?.caseSensitiveRoutes,
          },
          invokeMiddleware: async () => {
            // Middleware runs in Netlify Edge Function before the serverless function.
            // By the time the request reaches this handler, middleware has already executed.
            // Return a no-op result.
            return {}
          },
        }).then((resolved) =>
          preferStaticPathnameAfterRewrite(resolved, url, {
            pathnames: allPathnames,
            basePath: manifest.config.basePath || '',
            buildId: manifest.buildId,
            i18n: manifest.config.i18n as I18nForRouting | null,
          }),
        )
      } catch (error) {
        console.error('route resolution error', error)
        getLogger().withError(error).error('route resolution error')
        return new Response('Internal Server Error', { status: 500 })
      }
    }

    const applyResolutionToThisResponse = applyResolutionToResponse.bind(null, request, resolution)

    if (resolution.redirect) {
      // Handle explicit redirect
      const { url: redirectUrl, status } = resolution.redirect
      // TODO(adapter): this can be cached forever
      // but we would need to collect routing rules that were involved and inspect them as rules might rely on headers or other request properties,
      // which would require setting correct netlify-vary header.
      return applyResolutionToThisResponse(
        new Response(null, {
          status,
          headers: { location: redirectUrl.toString() },
        }),
      )
    }

    // Handle external rewrite
    if (resolution.externalRewrite) {
      try {
        return applyResolutionToThisResponse(
          await proxyExternalRewrite(resolution.externalRewrite, request),
        )
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
      return applyResolutionToThisResponse(
        new Response(null, { status: resolution.status }),
        resolution.status,
      )
    }

    // Handle matched route
    if (resolution.resolvedPathname) {
      span?.setAttribute('matched.pathname', resolution.resolvedPathname)
      const matchedHandler = handlerDefsByPathname.get(resolution.resolvedPathname)
      if (!matchedHandler) {
        return applyResolutionToThisResponse(
          new Response('Routing matched but no matched output exists', { status: 500 }),
        )
      }

      // Next's route modules expect req.url to be the URL the client requested (that's req.url and
      // asPath, and config rewrites are re-applied from it), the rewrite result travels separately.
      // The routing edge function forwards the rewrite target as the URL though (so the CDN can cache
      // by it) and passes the requested URL in a header.
      const publicUrl = request.headers.get('x-next-public-url') ?? request.url

      // Pages Router middleware prefetch (`Link` prefetch when middleware exists): Next's server
      // answers with an empty, non-cacheable result for pages without getStaticProps so the client
      // does the real data request on navigation instead of running getServerSideProps twice
      if (
        request.headers.has('x-middleware-prefetch') &&
        isNextDataPathname(new URL(publicUrl).pathname, routingBasics) &&
        !ssgPathnames.has(resolution.resolvedPathname)
      ) {
        return applyResolutionToThisResponse(
          new Response('{}', {
            headers: {
              'x-middleware-skip': '1',
              'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
              'content-type': 'application/json; charset=utf-8',
            },
          }),
        )
      }

      const handlerHeaders = setNextDataHeader(
        new Headers(request.headers),
        new URL(publicUrl),
        routingBasics,
      )

      const handlerResponse = await matchedHandler({
        request: new Request(publicUrl, {
          method: request.method,
          headers: handlerHeaders,
          body: request.body,
          // @ts-expect-error duplex is needed for streaming bodies
          duplex: 'half',
        }),
        requestContext,
        resolution,
        tracer,
        span,
      })

      if (isNotFoundPageRequest(request, resolution.resolvedPathname)) {
        // Next's server responds 404 here, and CACHE_404_PAGE cache-control handling keys off that
        const notFoundResponse = applyResolutionToThisResponse(handlerResponse, 404)
        setCacheControlHeaders(notFoundResponse, request, requestContext)
        return notFoundResponse
      }

      return applyResolutionToThisResponse(handlerResponse, resolution.status)
    }

    if (
      request.headers.has('x-nextjs-data') &&
      manifest.routing.shouldNormalizeNextData &&
      url.pathname.startsWith(`${manifest.config.basePath}/_next/data/${manifest.buildId}/`)
    ) {
      return Response.json({})
    }

    // No match found — 404
    // TODO(adapter): this can be cached forever because it will never match any routes
    // but we would need to collect routing rules that were involved and inspect them as rules might rely on headers or other request properties,
    // which would require setting correct netlify-vary header.
    return applyResolutionToThisResponse(
      await renderErrorPage(404, { request, requestContext, tracer, span }),
      404,
    )
  })
}
