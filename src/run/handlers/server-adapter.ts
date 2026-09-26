import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Span } from '@opentelemetry/api'
import type { NextConfigRuntime } from 'next-with-adapters/dist/server/config-shared.js'
import type { RouterServerContext } from 'next-with-adapters/dist/server/lib/router-utils/router-server-context.js'
import { getIsPossibleServerAction } from 'next-with-adapters/dist/server/lib/server-action-request-meta.js'
import type { RequestMeta } from 'next-with-adapters/dist/server/request-meta.js'

import {
  applyResolutionToResponse,
  isUnmatchedNextDataRequest,
  resolveRoutes,
  stripInternalRequestHeaders,
} from '../../adapter-runtime-shared/next-routing.js'
import type {
  ResolveRoutesParams,
  ResolveRoutesResult,
} from '../../adapter-runtime-shared/next-routing.js'
import { proxyExternalRewrite } from '../../adapter-runtime-shared/proxy-external-rewrite.js'
import {
  getPrerenderGroupBlobKey,
  getPrerenderGroupTags,
  HtmlBlob,
  type PrerenderGroupBlob,
} from '../../shared/blob-types.cjs'
import type { AdapterManifestComputeOutput } from '../config.js'
import { getAdapterManifest, getRunConfig, setRunConfig } from '../config.js'
import { PLUGIN_DIR } from '../constants.js'
import { toComputeResponse, toReqRes } from '../fetch-api-to-req-res.js'
import {
  adjustDateHeader,
  getRequestMeta,
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
import { isAnyTagStaleOrExpired, purgeEdgeCache } from './tags-handler.cjs'
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
  // shared by the invocations regenerating one prerender group, so Next renders it once
  invocationId?: string
  // Next's response as is, without our CDN headers (to store it)
  raw?: boolean
}

type Handler = (requestArgs: CommonHandlerArg) => Promise<Response> | Response

// Build a map of pathname -> handler output for quick lookup at request time
const handlerDefsByPathname = new Map<string, Handler>()
const handlerDefsId = new Map<string, Handler>()
const basePath = manifest.config.basePath || ''
// `@next/routing` resolves requests to these pathnames as given, so they double as handler keys
const routablePathnames: ResolveRoutesParams['pathnames'] = []
type RoutablePathnameType = Exclude<ResolveRoutesParams['pathnames'][number], string>['type']
function registerHandler(
  pathname: string,
  type: RoutablePathnameType,
  handler: Handler,
  route?: string,
) {
  handlerDefsByPathname.set(pathname, handler)
  routablePathnames.push(
    route && route !== pathname ? { pathname, type, route } : { pathname, type },
  )
}

type InvokeHandlerArg = {
  id: string
  entrypoint: string
  runtime: 'nodejs' | 'edge'
  sourcePage: string
}

// pages/app pages that are prerendered or fully static: those answer reads only, see readOnlyPathnames
const staticPageOutputIds = new Set(
  [...manifest.outputs.pages, ...manifest.outputs.appPages].map((output) => output.id),
)
const readOnlyPathnames = new Set<string>()

// pages with getStaticProps: prerenders point back at them, their data-route outputs share the
// sourcePage
const ssgParentIds = new Set(manifest.outputs.prerenders.map((output) => output.parentOutputId))
const ssgSourcePages = new Set(
  manifest.outputs.pages
    .filter((output) => ssgParentIds.has(output.id))
    .map((output) => output.sourcePage),
)
const ssgPathnames = new Set<string>()

function createInvokeHandler(output: AdapterManifestComputeOutput): Handler {
  return invokeHandler.bind(null, {
    id: output.id,
    entrypoint: output.filePath,
    runtime: output.runtime,
    sourcePage: output.sourcePage,
  })
}

// outputs that invoke compute (the runtime manifest is minimized, output types come from the list)
for (const [type, outputs] of [
  ['PAGES', manifest.outputs.pages],
  ['PAGES_API', manifest.outputs.pagesApi],
  ['APP_PAGE', manifest.outputs.appPages],
  ['APP_ROUTE', manifest.outputs.appRoutes],
] as const) {
  for (const output of outputs) {
    registerComputeOutput(type, output)
  }
}

function registerComputeOutput(type: RoutablePathnameType, output: AdapterManifestComputeOutput) {
  const handler = createInvokeHandler(output)
  handlerDefsId.set(output.id, handler)
  registerHandler(output.pathname, type, handler)
  if (ssgSourcePages.has(output.sourcePage)) {
    ssgPathnames.add(output.pathname)
  }
}

for (const output of manifest.outputs.prerenders) {
  const parentHandler = handlerDefsId.get(output.parentOutputId)
  if (!parentHandler) {
    throw new Error(
      `Prerender output ${output.id} has parentOutputId ${output.parentOutputId} which does not exist`,
    )
  }
  // params come from the route a prerender renders: `/en/posts/[slug]` may be a shell of
  // `/[locale]/posts/[slug]`
  registerHandler(output.pathname, 'PRERENDER', parentHandler, output.route)
  if (staticPageOutputIds.has(output.parentOutputId)) {
    readOnlyPathnames.add(output.pathname)
  }
  ssgPathnames.add(output.pathname)
}

// Prerender groups (adapter output `groupId`): one blob holds every variant of a prerendered path,
// they are regenerated and stored together (see copyPrerenderGroups)
type PrerenderOutput = (typeof manifest.outputs.prerenders)[number]
type PrerenderGroup = { entry?: PrerenderOutput; members: PrerenderOutput[] }
const prerendersByPathname = new Map<string, PrerenderOutput>()
const prerenderGroups = new Map<number, PrerenderGroup>()
for (const output of manifest.outputs.prerenders) {
  prerendersByPathname.set(output.pathname, output)
  const group = prerenderGroups.get(output.groupId) ?? { members: [] }
  group.members.push(output)
  if (output.isGroupEntry) {
    group.entry = output
  }
  prerenderGroups.set(output.groupId, group)
}

// Routing resolves to the group's page output; which variant is asked for comes from the
// `routing.rsc` headers (a data request is resolved by routing itself)
function getPrerenderVariant(
  resolvedPathname: string,
  headers: Headers,
  isDataRequest: boolean,
): PrerenderOutput | undefined {
  const output = prerendersByPathname.get(resolvedPathname)
  if (!output) {
    return
  }
  if (isDataRequest) {
    return prerenderGroups
      .get(output.groupId)
      ?.members.find((member) => member.pathname.startsWith(`${basePath}/_next/data/`))
  }
  const { rsc } = manifest.routing
  if (!rsc || headers.get(rsc.header) !== '1') {
    return output
  }
  if (
    resolvedPathname.endsWith(rsc.suffix) ||
    resolvedPathname.endsWith(rsc.prefetchSegmentSuffix)
  ) {
    return output
  }
  const base = resolvedPathname === (basePath || '/') ? `${basePath}/index` : resolvedPathname
  const segment =
    headers.get(rsc.prefetchHeader) === '1' ? headers.get(rsc.prefetchSegmentHeader) : null
  if (segment) {
    const segmentOutput = prerendersByPathname.get(
      `${base}${rsc.prefetchSegmentDirSuffix}${segment}${rsc.prefetchSegmentSuffix}`,
    )
    if (segmentOutput) {
      return segmentOutput
    }
  }
  // like Vercel: a segment prefetch without a segment output gets the full RSC payload
  return prerendersByPathname.get(`${base}${rsc.suffix}`)
}

function matchesHas(
  has: NonNullable<PrerenderOutput['bypassFor']>[number],
  request: Request,
  url: URL,
): boolean {
  let value: string | null | undefined
  switch (has.type) {
    case 'header':
      value = request.headers.get(has.key)
      break
    case 'query':
      value = url.searchParams.get(has.key)
      break
    case 'host':
      value = url.hostname
      break
    default:
      value = getCookie(request, has.key)
  }
  if (value === null || value === undefined) {
    return false
  }
  return has.value === undefined || new RegExp(`^${has.value}$`).test(value)
}

function getCookie(request: Request, name: string): string | undefined {
  for (const cookie of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = cookie.trim().split('=')
    if (key === name) {
      return value.join('=')
    }
  }
}

function shouldBypassPrerender(output: PrerenderOutput, request: Request, url: URL): boolean {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return true
  }
  // TODO(adapter): the adapter output has the token, the cookie name is Next's
  if (output.bypassToken && getCookie(request, '__prerender_bypass') === output.bypassToken) {
    return true
  }
  return (output.bypassFor ?? []).some((has) => matchesHas(has, request, url))
}

function getPrerenderGroupQuery(
  entry: PrerenderOutput,
  query: ResolveRoutesResult['resolvedQuery'],
): URLSearchParams {
  const params = new URLSearchParams()
  for (const key of entry.allowQuery ?? []) {
    const value = query?.[key]
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      params.append(key, item)
    }
  }
  return params
}

// Next's `s-maxage=R, stale-while-revalidate=E-R`; without s-maxage the response isn't cacheable
function parseNextCacheControl(
  cacheControl: string | undefined,
): Pick<PrerenderGroupBlob, 'revalidate' | 'expire'> | undefined {
  const directives = new Map(
    (cacheControl ?? '').split(',').map((directive) => {
      const [key, value] = directive.trim().split('=')
      return [key.toLowerCase(), value] as const
    }),
  )
  const sMaxAge = Number(directives.get('s-maxage'))
  if (!Number.isFinite(sMaxAge) || sMaxAge <= 0) {
    return
  }
  if (sMaxAge >= 31536000) {
    return { revalidate: false, expire: undefined }
  }
  const staleWhileRevalidate = Number(directives.get('stale-while-revalidate'))
  return {
    revalidate: sMaxAge,
    expire: Number.isFinite(staleWhileRevalidate) ? sMaxAge + staleWhileRevalidate : undefined,
  }
}

// `/fallback-true/[slug]` with `nxtPslug=hello` is `/fallback-true/hello`
function interpolatePrerenderPathname(pathname: string, params: URLSearchParams): string {
  return pathname.replace(/\/\[(\[)?(?:\.{3})?([^\]]+)]]?/g, (segment, optional, name: string) => {
    const values = params.getAll(`nxtP${name}`)
    if (values.length !== 0) {
      return `/${values.join('/')}`
    }
    return optional ? '' : segment
  })
}

async function regeneratePrerenderGroup(
  groupKey: string,
  group: Required<PrerenderGroup>,
  params: URLSearchParams,
  args: CommonHandlerArg,
): Promise<PrerenderGroupBlob> {
  const invocationId = randomUUID()
  const variants: PrerenderGroupBlob['variants'] = {}
  // the entry first: its render fills Next's response cache for the other variants
  for (const member of [group.entry, ...group.members.filter((item) => item !== group.entry)]) {
    const handler = handlerDefsId.get(member.parentOutputId)
    if (!handler) {
      continue
    }
    const url = new URL(member.pathname, args.request.url)
    url.search = params.toString()
    const response = await handler({
      ...args,
      request: new Request(url),
      resolution: {},
      invocationId,
      raw: true,
    })
    variants[member.pathname] = {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()).toString('base64'),
    }
  }

  const entryHeaders = variants[group.entry.pathname]?.headers ?? {}
  const cacheControl = parseNextCacheControl(entryHeaders['cache-control'])
  const blob: PrerenderGroupBlob = {
    lastModified: Date.now(),
    revalidate: cacheControl?.revalidate ?? false,
    expire: cacheControl?.expire,
    tags: getPrerenderGroupTags(
      interpolatePrerenderPathname(group.entry.pathname, params),
      entryHeaders['x-next-cache-tags'],
    ),
    variants,
  }
  if (cacheControl) {
    const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })
    await store.set(groupKey, blob, 'prerenderGroup.set')
  }
  return blob
}

// `x-prerender-revalidate: <bypassToken>` (Pages Router `res.revalidate()`): regenerate now, and
// with `x-prerender-revalidate-if-generated` only a group generated before
type OnDemandRevalidate = { onlyGenerated: boolean }

async function servePrerenderGroup(
  variant: PrerenderOutput,
  group: Required<PrerenderGroup>,
  args: CommonHandlerArg,
  onDemand?: OnDemandRevalidate,
): Promise<Response | undefined> {
  const { request, requestContext, resolution } = args
  const params = getPrerenderGroupQuery(
    group.entry,
    resolution.resolvedQuery ?? resolution.invocation?.requestMeta.query,
  )
  const paramsString = params.toString()
  const groupKey = getPrerenderGroupBlobKey(
    paramsString ? `${group.entry.pathname}?${paramsString}` : group.entry.pathname,
  )
  const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })
  let blob = await store.get<PrerenderGroupBlob>(groupKey, 'prerenderGroup.get')
  let nextCache: 'HIT' | 'STALE' | 'MISS' = 'HIT'

  if (onDemand) {
    if (onDemand.onlyGenerated && !blob) {
      return new Response('This page could not be found', { status: 404 })
    }
    blob = await regeneratePrerenderGroup(groupKey, group, params, args)
    requestContext.trackBackgroundWork(purgeEdgeCache(blob.tags))
    nextCache = 'MISS'
  } else if (blob) {
    const age = (Date.now() - blob.lastModified) / 1000
    const tags = await isAnyTagStaleOrExpired(blob.tags, blob.lastModified)
    const expired = tags.expired || (blob.expire !== undefined && age > blob.expire)
    const stale = tags.stale || (blob.revalidate !== false && age > blob.revalidate)
    if (expired || (stale && requestContext.isBackgroundRevalidation)) {
      blob = null
    } else if (stale) {
      nextCache = 'STALE'
      requestContext.trackBackgroundWork(
        regeneratePrerenderGroup(groupKey, group, params, args).then(
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          () => {},
          (error) => getLogger().withError(error).error('prerender group regeneration error'),
        ),
      )
    }
  }

  if (!blob?.variants[variant.pathname]) {
    nextCache = 'MISS'
    blob = await regeneratePrerenderGroup(groupKey, group, params, args)
  }
  const stored = blob.variants[variant.pathname]
  if (!stored) {
    return
  }

  const response = new Response(
    request.method === 'HEAD' ? null : Buffer.from(stored.body, 'base64'),
    { status: stored.status, headers: stored.headers },
  )
  response.headers.set('x-nextjs-cache', nextCache)
  if (nextCache !== 'MISS') {
    requestContext.responseCacheGetLastModified = blob.lastModified
  }
  if (!stored.headers['x-next-cache-tags']) {
    requestContext.responseCacheTags ??= blob.tags
  }
  await applyCacheHeaders(response, request, requestContext)
  return response
}

async function applyCacheHeaders(
  response: Response,
  request: Request,
  requestContext: RequestContext,
  span?: Parameters<typeof adjustDateHeader>[0]['span'],
) {
  // in minimal mode Next leaves the tags on the response instead of going through the cache handler
  const nextCacheTags = response.headers.get('x-next-cache-tags')
  if (nextCacheTags) {
    requestContext.responseCacheTags ??= nextCacheTags.split(',')
    response.headers.delete('x-next-cache-tags')
  }

  const nextCache = response.headers.get('x-nextjs-cache')
  if (nextCache === 'HIT' || nextCache === 'STALE') {
    await adjustDateHeader({ headers: response.headers, request, span, requestContext })
  }
  setCacheControlHeaders(response, request, requestContext)
  setCacheTagsHeaders(response.headers, requestContext)
  setVaryHeaders(response.headers, request, manifest.config as Parameters<typeof setVaryHeaders>[2])
  setCacheStatusHeader(response.headers, nextCache)
}

// serve static files
type StaticFileHandlerArg = {
  filePath: string
  pathname: string
}
function createStaticFileHandler(output: StaticFileHandlerArg): Handler {
  return serverStaticFile.bind(null, output)
}

// `public/` files live on the CDN, so a direct request never reaches the function — but a rewrite
// resolved here does, and then the file has to be fetched from the CDN like any other static output
for (const pathname of manifest.publicPathnames) {
  registerHandler(
    pathname,
    'STATIC_FILE',
    createStaticFileHandler({ filePath: `public${pathname.slice(basePath.length)}`, pathname }),
  )
}

for (const output of manifest.outputs.staticFiles) {
  readOnlyPathnames.add(output.pathname)
  registerHandler(
    output.pathname,
    'STATIC_FILE',
    createStaticFileHandler({ filePath: output.filePath, pathname: output.pathname }),
  )
}

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
 * Custom error page for the request, like Next's router: 404 renders app router `/_not-found` if
 * the app has one, else pages router `/404` (locale variant first); 500 renders `/500`. The app
 * entry wins even over a custom `pages/404` and even under i18n, which is what base-server does
 * (it looks up `/_not-found/page` first and only falls back to `/404`). Both fall back to `/_error`,
 * which is what a Pages Router app with a custom `_error` but no `404.js` has. The page is invoked
 * with the requested URL (Next passes the error page as `invokePath`, `req.url` stays the original,
 * and `pages/_error` reports it as `reqUrl`/`asPath`).
 */
async function renderErrorPage(
  status: 404 | 500,
  { request, requestContext, tracer, span }: Omit<CommonHandlerArg, 'resolution'>,
): Promise<Response> {
  const url = new URL(request.url)
  const candidates: string[] = []
  if (status === 404) {
    candidates.push(`${basePath}/_not-found`)
  }
  if (manifest.config.i18n) {
    const { locales, defaultLocale } = manifest.config.i18n
    const segment = url.pathname.slice(basePath.length).split('/')[1]?.toLowerCase()
    const locale = locales.find((value) => value.toLowerCase() === segment) ?? defaultLocale
    candidates.push(`${basePath}/${locale}/${status}`)
  }
  candidates.push(`${basePath}/${status}`, `${basePath}/_error`)

  const pathname = candidates.find((candidate) => handlerDefsByPathname.has(candidate))
  const handler = pathname ? handlerDefsByPathname.get(pathname) : undefined
  if (!pathname || !handler) {
    return new Response(status === 404 ? 'Not Found' : 'Internal Server Error', { status })
  }

  const response = await handler({
    request: new Request(request.url, { headers: request.headers }),
    requestContext,
    resolution: {},
    tracer,
    span,
    invokeStatus: status,
  })

  // The error page keeps the cache headers of whatever rendered it. A static `404.html` is build
  // output that only a deploy can change, and a prerendered not-found carries its own revalidate,
  // so both are cacheable; forcing no-store here would put an origin hit on every bot probe. That
  // matches what Vercel serves for every not-found shape except a fully static `pages/404.js`,
  // which they leave uncached (measured 2026-09-18, see docs/404-caching-vercel-matrix.md).
  const errorResponse = new Response(response.body, { status, headers: response.headers })
  setCacheControlHeaders(errorResponse, request, requestContext)
  // A cacheable 404 still has to miss for preview requests: a `fallback: false` path that is not
  // prerendered answers 404 to everyone but renders for the preview cookie, and the static-file
  // handler that produced this response only varies on the query.
  setVaryHeaders(
    errorResponse.headers,
    request,
    manifest.config as Parameters<typeof setVaryHeaders>[2],
  )
  return errorResponse
}

// a literal request for the 404 page (or its locale variant) responds with 404, like Next's server
// does, unless it's the on-demand revalidation of that page
// A direct visit to `pages/404` or `pages/500` answers with that status, as Next's server and the
// Vercel builder both do; without middleware there is nothing else to say otherwise.
function isStatusPageRequest(
  request: Request,
  resolvedPathname: string,
  status: 404 | 500,
): boolean {
  if (request.headers.has('x-prerender-revalidate')) {
    return false
  }
  if (resolvedPathname === `${basePath}/${status}`) {
    return true
  }
  const locales = manifest.config.i18n?.locales ?? []
  return locales.some((locale) => resolvedPathname === `${basePath}/${locale}/${status}`)
}

function isNotFoundPageRequest(request: Request, resolvedPathname: string): boolean {
  return isStatusPageRequest(request, resolvedPathname, 404)
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

async function serverStaticFile(
  { filePath, pathname }: StaticFileHandlerArg,
  { request }: CommonHandlerArg,
) {
  // only static HTML pages live in blobs (copyStaticContent), every other static output is on the
  // CDN (copyStaticAssets). A request for the file itself never reaches the function then, so
  // getting here means a rewrite landed on it: fetch it from the CDN.
  const [, pagesBlobKey] = filePath.split('/server/pages/')
  if (!pagesBlobKey) {
    if (new URL(request.url).pathname === pathname) {
      // the CDN doesn't have it either (see copyStaticAssets), don't loop through it
      return new Response('Not Found', { status: 404 })
    }
    return proxyExternalRewrite(new URL(pathname, request.url), request)
  }

  const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore()
  const htmlFile = await cacheStore.get<HtmlBlob>(pagesBlobKey, 'staticHtml.get')

  const headers = new Headers()
  let body = 'Not found static file'
  let status = 404

  if (htmlFile) {
    body = htmlFile.html
    status = 200
    headers.set('Content-Type', 'text/html; charset=utf-8')
    // Next appends this to any response to a flight request, Pages Router included, "to avoid
    // caching issues when navigating between pages and app" (`base-server` `setVaryHeader`). This
    // handler answers from stored HTML without going through a route module, so do it here too.
    if (request.headers.has('rsc')) {
      headers.set(
        'vary',
        'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
      )
    }
    // ...and tell the CDN, which caches this response for a year: without it the entry is keyed by
    // query alone, so a flight request that arrives without Next's `_rsc` cache-buster would be
    // served the HTML copy. The invoke path does this for every other response.
    setVaryHeaders(headers, request, manifest.config as Parameters<typeof setVaryHeaders>[2])
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

// Next's router answers a no-match for `_next/static` assets with plain text instead of rendering
// the 404 page (router-server "404 case"). It does the same for non-HTML `sec-fetch-dest` requests,
// but upstream tests expect the HTML 404 for those when deployed (Vercel's CDN behaviour), so only
// the static-asset rule is mirrored.
function isPlainNotFoundRequest(url: URL): boolean {
  let { pathname } = url
  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || '/'
  }
  const { assetPrefix, i18n } = manifest.config
  if (assetPrefix) {
    const prefix = URL.canParse(assetPrefix) ? new URL(assetPrefix).pathname : assetPrefix
    if (prefix !== '/' && pathname.startsWith(prefix)) {
      pathname = pathname.slice(prefix.length) || '/'
    }
  }
  const [, first = ''] = pathname.split('/')
  const locale = i18n?.locales.find((value) => value.toLowerCase() === first.toLowerCase())
  if (locale) {
    pathname = pathname.slice(locale.length + 1) || '/'
  }
  return pathname.startsWith('/_next/static/')
}

async function invokeHandler(
  { id, entrypoint, runtime, sourcePage }: InvokeHandlerArg,
  {
    tracer,
    request,
    requestContext,
    resolution,
    span,
    invokeStatus,
    invocationId,
    raw,
  }: CommonHandlerArg,
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
          routeParams: resolution.invocation?.requestMeta.params,
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

      // `@next/routing` says how to invoke the matched output (`req.url`, request meta), quirks
      // included; error pages are invoked without a resolution
      const { invocation } = resolution
      const handlerRequest = invocation
        ? new Request(new URL(invocation.url, request.url), request)
        : request
      // without one Next's minimal-mode response cache reuses renders across requests for 10s
      handlerRequest.headers.set('x-invocation-id', invocationId ?? randomUUID())

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
          ...(invocation?.requestMeta ?? { initURL: request.url }),
          render404,
          revalidate,
          minimalMode: true,
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

      if (raw) {
        // not the background work: a regeneration running as background work reads this body
        const untilRendered = new TransformStream({
          async flush() {
            await nextHandlerPromise.catch(() => {
              // reported where the handler promise is created
            })
            res.emit('close')
          },
        })
        return new Response(response.body?.pipeThrough(untilRendered), response)
      }

      await applyCacheHeaders(response, request, requestContext, invokeSpan)

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
 * Deserialize a ResolveRoutesResult from the private meta header the edge function sets.
 * The routing edge function serializes the resolution as JSON with
 * Headers → plain object, URL → string conversions.
 */
function deserializeResolution(serialized: string): ResolveRoutesResult {
  const parsed = JSON.parse(serialized) as {
    resolvedPathname: string | null
    resolvedQuery: ResolveRoutesResult['resolvedQuery'] | null
    invocationTarget: ResolveRoutesResult['invocationTarget'] | null
    routeMatches: Record<string, string> | null
    invocation?: ResolveRoutesResult['invocation'] | null
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
  if (parsed.invocation) {
    resolution.invocation = parsed.invocation
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

    // Without the routing edge function in front (no middleware, or it isn't deployed) this is where
    // the request enters, so drop the headers Next's own tiers use to talk to each other, like
    // router-server does. Behind the edge function they are ours: middleware puts the cookies it set
    // in `x-middleware-set-cookie` for the render.
    const requestMeta = getRequestMeta(request)
    const serializedResolution = requestMeta?.routeResolution
    const requestHeaders = serializedResolution
      ? new Headers(request.headers)
      : stripInternalRequestHeaders(new Headers(request.headers))

    if (serializedResolution) {
      // Resolution was computed by the routing edge function — skip resolveRoutes
      resolution = deserializeResolution(serializedResolution)
    } else {
      // No edge function (standalone mode fallback, or edge function not deployed)
      try {
        resolution = await resolveRoutes({
          url,
          buildId: manifest.buildId,
          basePath: manifest.config.basePath || '',
          requestBody: request.body ?? new ReadableStream(),
          headers: requestHeaders,
          pathnames: routablePathnames,
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
        })
      } catch (error) {
        console.error('route resolution error', error)
        getLogger().withError(error).error('route resolution error')
        return new Response('Internal Server Error', { status: 500 })
      }
    }

    const applyResolutionToThisResponse = applyResolutionToResponse.bind(null, {
      request,
      resolution,
      basePath,
    })

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
        // A rewrite whose target has no output - middleware sending `/x` to `/en-EN/x` in an app
        // with no such route, say. Next's router 404s on the target rather than erroring.
        span?.setAttribute('matched.noOutput', true)
        return applyResolutionToThisResponse(
          await renderErrorPage(404, { request, requestContext, tracer, span }),
          404,
        )
      }

      // A prerendered or fully static page answers reads only: Next's router-server sets
      // `Allow: GET, HEAD` and 405s every other method on a static output, and base-server does the
      // same for an SSG page. Route modules carry neither check, so it lands on the host (adapter-k8s
      // gates its static serves the same way). Server actions and postponed resumes legitimately
      // POST to a page URL — and a form-submitted action carries no `next-action` header, only a
      // form content-type, so ask Next the same way base-server does.
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        readOnlyPathnames.has(resolution.resolvedPathname) &&
        !getIsPossibleServerAction({
          method: request.method,
          headers: request.headers,
        } as Parameters<typeof getIsPossibleServerAction>[0]) &&
        !request.headers.has('next-resume')
      ) {
        return applyResolutionToThisResponse(
          new Response('Method Not Allowed', {
            status: 405,
            headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
          }),
          405,
        )
      }

      // Next's route modules expect req.url to be the URL the client requested (that's req.url and
      // asPath, and config rewrites are re-applied from it), the rewrite result travels separately.
      // The routing edge function forwards the rewrite target as the URL though (so the CDN can cache
      // by it) and passes the requested URL in the private meta header.
      const publicUrl = requestMeta?.publicUrl ?? request.url

      // Pages Router middleware prefetch (`Link` prefetch when middleware exists): Next's server
      // answers with an empty, non-cacheable result for pages without getStaticProps so the client
      // does the real data request on navigation instead of running getServerSideProps twice
      if (
        request.headers.has('x-middleware-prefetch') &&
        resolution.invocation?.headers['x-nextjs-data'] &&
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

      // `x-nextjs-data` as routing decided it: set for data requests, never trusted from the client
      const handlerHeaders = new Headers(requestHeaders)
      if (resolution.invocation?.headers['x-nextjs-data']) {
        handlerHeaders.set('x-nextjs-data', '1')
      } else {
        handlerHeaders.delete('x-nextjs-data')
      }

      const handlerArgs: CommonHandlerArg = {
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
      }

      let handlerResponse: Response | undefined
      const prerenderVariant = getPrerenderVariant(
        resolution.resolvedPathname,
        requestHeaders,
        Boolean(resolution.invocation?.headers['x-nextjs-data']),
      )
      const prerenderGroup = prerenderVariant && prerenderGroups.get(prerenderVariant.groupId)
      if (
        prerenderVariant &&
        prerenderGroup?.entry &&
        !shouldBypassPrerender(prerenderVariant, request, url)
      ) {
        const isOnDemandRevalidate =
          prerenderVariant.bypassToken !== undefined &&
          request.headers.get('x-prerender-revalidate') === prerenderVariant.bypassToken
        handlerResponse = await servePrerenderGroup(
          prerenderVariant,
          prerenderGroup as Required<PrerenderGroup>,
          handlerArgs,
          isOnDemandRevalidate
            ? { onlyGenerated: request.headers.has('x-prerender-revalidate-if-generated') }
            : undefined,
        )
      }
      handlerResponse ??= await matchedHandler(handlerArgs)

      if (isNotFoundPageRequest(request, resolution.resolvedPathname)) {
        // Next's server responds 404 here, and CACHE_404_PAGE cache-control handling keys off that
        const notFoundResponse = applyResolutionToThisResponse(handlerResponse, 404)
        setCacheControlHeaders(notFoundResponse, request, requestContext)
        setVaryHeaders(
          notFoundResponse.headers,
          request,
          manifest.config as Parameters<typeof setVaryHeaders>[2],
        )
        return notFoundResponse
      }
      if (isStatusPageRequest(request, resolution.resolvedPathname, 500)) {
        return applyResolutionToThisResponse(handlerResponse, 500)
      }

      return applyResolutionToThisResponse(handlerResponse, resolution.status)
    }

    // the edge function answers this itself; behind it `url` is the rewrite target
    if (
      isUnmatchedNextDataRequest(new URL(requestMeta?.publicUrl ?? request.url), resolution, {
        basePath: manifest.config.basePath || '',
        buildId: manifest.buildId,
        middlewareMatchers: manifest.routing.middlewareMatchers,
      })
    ) {
      return applyResolutionToThisResponse(Response.json({}))
    }

    // No match found — 404
    if (isPlainNotFoundRequest(url)) {
      return applyResolutionToThisResponse(
        new Response('Not Found', {
          status: 404,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
          },
        }),
        404,
      )
    }
    // TODO(adapter): this can be cached forever because it will never match any routes
    // but we would need to collect routing rules that were involved and inspect them as rules might rely on headers or other request properties,
    // which would require setting correct netlify-vary header.
    return applyResolutionToThisResponse(
      await renderErrorPage(404, { request, requestContext, tracer, span }),
      404,
    )
  })
}
