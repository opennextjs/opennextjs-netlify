import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'

import type { RequestMeta } from 'next-with-adapters/dist/server/request-meta.js'

import {
  answerWithoutCompute,
  applyResolutionToResponse,
  isUnmatchedNextDataRequest,
  resolve,
  stripInternalRequestHeaders,
} from '../../adapter-runtime-shared/next-routing.js'
import type { ResolveRoutesResult } from '../../adapter-runtime-shared/next-routing.js'
import { proxyExternalRewrite } from '../../adapter-runtime-shared/proxy-external-rewrite.js'
import { HtmlBlob } from '../../shared/blob-types.cjs'
import { PLUGIN_DIR } from '../constants.js'
import { getRequestMeta, setVaryHeaders } from '../headers.js'
import {
  getMemoizedKeyValueStoreBackedByRegionalBlobStore,
  setFetchBeforeNextPatchedIt,
  setInMemoryCacheMaxSizeFromNextConfig,
} from '../storage/storage.cjs'

import { cacheOf, finalize, setCacheControl } from './adapter/finalize.js'
import { configureInvoke, invokeHandler } from './adapter/invoke.js'
import {
  basePath,
  manifest,
  outputsByPathname,
  type PrerenderGroup,
  prerenderGroups,
  type PrerenderOutput,
  prerendersByPathname,
  readOnlyPathnames,
  type RoutedOutput,
  ssgPathnames,
  type StaticFileHandlerArg,
} from './adapter/manifest.js'
import {
  getPrerenderGroupPostponed,
  type OnDemandRevalidate,
  servePrerenderGroup,
} from './adapter/prerender-store.js'
import type {
  AdapterRequestContext,
  InvokeOptions,
  Produced,
  ProduceRequest,
} from './adapter/types.js'
import { NetlifyAdapterCacheHandler } from './cache-adapter.cjs'
import { getLogger, getRequestContext } from './request-context.cjs'
import { getTracer, withActiveSpan } from './tracer.cjs'
import { configureFetchCacheHandler, configureUseCacheHandlers } from './use-cache-handler.js'

// Next's server loads .env files at startup, route modules don't. PLUGIN_DIR is the app dir in the
// handler where the .env files were copied to, and @next/env resolves to the app's copy shipped there.
// @next/env is CommonJS, so the named export is only there when cjs-module-lexer detects it
const nextEnv =
  // eslint-disable-next-line import/no-extraneous-dependencies, n/no-extraneous-import
  (await import('@next/env')) as typeof import('@next/env') & {
    default?: typeof import('@next/env')
  }
;(nextEnv.default ?? nextEnv).loadEnvConfig(PLUGIN_DIR, false)

// make use of global fetch before Next.js applies any patching
setFetchBeforeNextPatchedIt(globalThis.fetch)
// configure globals that Next.js make use of before we start importing any Next.js code
// as some globals are consumed at import time
// adapter mode needs a Next.js with CacheHandlerV2 (>=15.3.0-canary.13), see MIN_NEXT_VERSION
configureUseCacheHandlers()
// minimal mode only caches `FETCH` entries through the incremental cache. Same as Vercel: the
// handler is the global `FetchCache` (see configureUseCacheHandlers for why not a config path), so
// an app's own `cacheHandler` takes precedence.
configureFetchCacheHandler(NetlifyAdapterCacheHandler)
setInMemoryCacheMaxSizeFromNextConfig(manifest.config.cacheMaxMemorySize)

// Next.js checks globalThis.AsyncLocalStorage to decide whether to use real
// or fake (throwing) AsyncLocalStorage. Must be set before any Next.js code loads
// (the dynamic import() of route entrypoints happens at request time, after this).
if (!('AsyncLocalStorage' in globalThis)) {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.AsyncLocalStorage = AsyncLocalStorage
}

function produceOutput(
  routed: RoutedOutput,
  args: ProduceRequest,
  options?: InvokeOptions,
): Promise<Produced> {
  return routed.kind === 'compute'
    ? invokeHandler(routed.output, args, options)
    : serverStaticFile(routed.file, args)
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
  const { rsc } = manifest
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

// like Next's getIsPossibleServerAction (server/lib/server-action-request-meta.ts)
function isPossibleServerAction(request: Request): boolean {
  const contentType = request.headers.get('content-type')
  return (
    request.method === 'POST' &&
    (request.headers.has('next-action') ||
      contentType === 'application/x-www-form-urlencoded' ||
      Boolean(contentType?.startsWith('multipart/form-data')))
  )
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

/**
 * What a request resolved to `pathname` is for: an output (served from its prerender group when
 * there is one to serve), an error page, or an answer dispatch gives itself.
 */
type Target =
  | {
      kind: 'output'
      output: RoutedOutput
      prerender?: {
        variant: PrerenderOutput
        group: Required<PrerenderGroup>
        onDemand?: OnDemandRevalidate
      }
      // a server action on a PPR page renders with the page's postponed state
      postponedFrom?: Required<PrerenderGroup>
    }
  | { kind: 'error'; status: 404 }
  | { kind: 'answer'; response: Response; status?: number }

function dispatch(
  pathname: string,
  resolution: ResolveRoutesResult,
  request: Request,
  requestHeaders: Headers,
): Target {
  const url = new URL(request.url)
  const output = outputsByPathname.get(pathname)
  if (!output) {
    // A rewrite whose target has no output - middleware sending `/x` to `/en-EN/x` in an app
    // with no such route, say. Next's router 404s on the target rather than erroring.
    return { kind: 'error', status: 404 }
  }

  // A prerendered or fully static page answers reads only: Next's router-server sets
  // `Allow: GET, HEAD` and 405s every other method on a static output, and base-server does the
  // same for an SSG page. Route modules carry neither check, so it lands on the host (adapter-k8s
  // gates its static serves the same way). Server actions and postponed resumes legitimately
  // POST to a page URL — and a form-submitted action carries no `next-action` header, only a
  // form content-type, so check it the same way base-server does.
  if (
    !['GET', 'HEAD'].includes(request.method) &&
    readOnlyPathnames.has(pathname) &&
    !isPossibleServerAction(request) &&
    !request.headers.has('next-resume')
  ) {
    return {
      kind: 'answer',
      response: new Response('Method Not Allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
      }),
      status: 405,
    }
  }

  const isDataRequest = Boolean(resolution.invocation?.headers['x-nextjs-data'])
  // Pages Router middleware prefetch (`Link` prefetch when middleware exists): Next's server
  // answers with an empty, non-cacheable result for pages without getStaticProps so the client
  // does the real data request on navigation instead of running getServerSideProps twice
  if (
    request.headers.has('x-middleware-prefetch') &&
    isDataRequest &&
    !ssgPathnames.has(pathname)
  ) {
    return {
      kind: 'answer',
      response: new Response('{}', {
        headers: {
          'x-middleware-skip': '1',
          'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
          'content-type': 'application/json; charset=utf-8',
        },
      }),
    }
  }

  const variant = getPrerenderVariant(pathname, requestHeaders, isDataRequest)
  const group = variant && prerenderGroups.get(variant.groupId)
  if (!variant || !group?.entry) {
    return { kind: 'output', output }
  }
  if (!shouldBypassPrerender(variant, request, url)) {
    const isOnDemandRevalidate =
      variant.bypassToken !== undefined &&
      request.headers.get('x-prerender-revalidate') === variant.bypassToken
    return {
      kind: 'output',
      output,
      prerender: {
        variant,
        group: group as Required<PrerenderGroup>,
        onDemand: isOnDemandRevalidate
          ? { onlyGenerated: request.headers.has('x-prerender-revalidate-if-generated') }
          : undefined,
      },
    }
  }
  const isActionOnPprPage =
    group.entry.resumeHeaders &&
    request.method === 'POST' &&
    (variant.bypassFor ?? []).some((has) => matchesHas(has, request, url))
  // a server action (the output's `bypassFor`) on a PPR page, see the adapter docs
  return isActionOnPprPage
    ? { kind: 'output', output, postponedFrom: group as Required<PrerenderGroup> }
    : { kind: 'output', output }
}

async function produceTarget(
  { output, prerender, postponedFrom }: Extract<Target, { kind: 'output' }>,
  args: ProduceRequest,
): Promise<Produced> {
  if (prerender) {
    const served = await servePrerenderGroup(
      prerender.variant,
      prerender.group,
      args,
      prerender.onDemand,
    )
    if (served) {
      return served
    }
  }
  return produceOutput(
    output,
    args,
    postponedFrom && { postponed: await getPrerenderGroupPostponed(postponedFrom, args) },
  )
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
  { request, requestContext, tracer, span }: Omit<ProduceRequest, 'resolution'>,
): Promise<Produced> {
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

  const pathname = candidates.find((candidate) => outputsByPathname.has(candidate))
  const routed = pathname ? outputsByPathname.get(pathname) : undefined
  if (!pathname || !routed) {
    return {
      kind: 'final',
      response: new Response(status === 404 ? 'Not Found' : 'Internal Server Error', { status }),
    }
  }

  const errorArgs: ProduceRequest = {
    request: new Request(request.url, { headers: request.headers }),
    requestContext,
    resolution: {},
    tracer,
    span,
    invokeStatus: status,
  }
  // a prerendered error page is served like a request for it: in minimal mode Next only renders
  // the static shell of a PPR page, the rest comes from resuming the group's postponed state
  const variant = getPrerenderVariant(pathname, request.headers, false)
  const group = variant && prerenderGroups.get(variant.groupId)
  const produced = await produceTarget(
    {
      kind: 'output',
      output: routed,
      ...(variant &&
        group?.entry && { prerender: { variant, group: group as Required<PrerenderGroup> } }),
    },
    errorArgs,
  )
  return { kind: 'error', status, produced }
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
  const requestContext: AdapterRequestContext | undefined = getRequestContext()
  if (!requestContext?.originalRequest) {
    throw new Error('render404 called outside of request context')
  }
  // Next calls this mid-render and takes the page into its own response, so it is final here
  const response = await finalize(
    await renderErrorPage(404, {
      request: requestContext.originalRequest,
      requestContext,
      tracer: getTracer(),
    }),
    requestContext.originalRequest,
  )
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
  const requestContext: AdapterRequestContext | undefined = getRequestContext()
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

configureInvoke({ render404, revalidate, renderErrorPage })

async function serverStaticFile(
  { filePath, pathname }: StaticFileHandlerArg,
  { request }: ProduceRequest,
): Promise<Produced> {
  // only static HTML pages live in blobs (copyStaticContent), every other static output is on the
  // CDN (copyStaticAssets). A request for the file itself never reaches the function then, so
  // getting here means a rewrite landed on it: fetch it from the CDN.
  const [, pagesBlobKey] = filePath.split('/server/pages/')
  if (!pagesBlobKey) {
    if (new URL(request.url).pathname === pathname) {
      // the CDN doesn't have it either (see copyStaticAssets), don't loop through it
      return { kind: 'final', response: new Response('Not Found', { status: 404 }) }
    }
    return {
      kind: 'final',
      response: await proxyExternalRewrite(new URL(pathname, request.url), request),
    }
  }

  const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore()
  const htmlFile = await cacheStore.get<HtmlBlob>(pagesBlobKey, 'staticHtml.get')

  if (!htmlFile) {
    return { kind: 'final', response: new Response('Not found static file', { status: 404 }) }
  }

  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' })
  // Next appends this to any response to a flight request, Pages Router included, "to avoid
  // caching issues when navigating between pages and app" (`base-server` `setVaryHeader`). This
  // handler answers from stored HTML without going through a route module, so do it here too.
  if (request.headers.has('rsc')) {
    headers.set(
      'vary',
      'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
    )
  }
  return {
    kind: 'static-page',
    response: new Response(htmlFile.html, { headers, status: 200 }),
    fullyStatic: Boolean(htmlFile.isFullyStaticPage),
  }
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

export default async function ServerHandler(
  request: Request,
  requestContext: AdapterRequestContext,
) {
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
        resolution = await resolve(
          { url, headers: requestHeaders, requestBody: request.body ?? new ReadableStream() },
          manifest.routingConfig,
        )
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

    const answered = await answerWithoutCompute(resolution, {
      request,
      basePath,
      outgoingRequest: () =>
        new Request(request.url, {
          method: request.method,
          headers: requestHeaders,
          body: request.body,
          // @ts-expect-error duplex is needed for streaming bodies
          duplex: 'half',
        }),
    })
    if (answered) {
      return answered
    }

    // Handle matched route
    if (resolution.resolvedPathname) {
      span?.setAttribute('matched.pathname', resolution.resolvedPathname)
      const target = dispatch(resolution.resolvedPathname, resolution, request, requestHeaders)
      if (target.kind === 'error') {
        span?.setAttribute('matched.noOutput', true)
        return finalize(
          await renderErrorPage(target.status, { request, requestContext, tracer, span }),
          request,
          (response) => applyResolutionToThisResponse(response, target.status),
        )
      }
      if (target.kind === 'answer') {
        return applyResolutionToThisResponse(target.response, target.status)
      }

      // Next's route modules expect req.url to be the URL the client requested (that's req.url and
      // asPath, and config rewrites are re-applied from it), the rewrite result travels separately.
      // The routing edge function forwards the rewrite target as the URL though (so the CDN can cache
      // by it) and passes the requested URL in the private meta header.
      const publicUrl = requestMeta?.publicUrl ?? request.url

      // `x-nextjs-data` as routing decided it: set for data requests, never trusted from the client
      const handlerHeaders = new Headers(requestHeaders)
      if (resolution.invocation?.headers['x-nextjs-data']) {
        handlerHeaders.set('x-nextjs-data', '1')
      } else {
        handlerHeaders.delete('x-nextjs-data')
      }

      const handlerArgs: ProduceRequest = {
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

      const produced = await produceTarget(target, handlerArgs)

      const isNotFoundPage = isNotFoundPageRequest(request, resolution.resolvedPathname)
      const status = isNotFoundPage
        ? 404
        : isStatusPageRequest(request, resolution.resolvedPathname, 500)
          ? 500
          : resolution.status
      const response = await finalize(produced, handlerArgs.request, (routed) =>
        applyResolutionToThisResponse(routed, status),
      )
      if (isNotFoundPage) {
        // Next's server responds 404 here, and CACHE_404_PAGE cache-control handling keys off that
        setCacheControl(response, request, cacheOf(produced)?.revalidate)
        setVaryHeaders(
          response.headers,
          request,
          manifest.config as Parameters<typeof setVaryHeaders>[2],
        )
      }
      return response
    }

    // the edge function answers this itself; behind it `url` is the rewrite target
    if (
      isUnmatchedNextDataRequest(new URL(requestMeta?.publicUrl ?? request.url), resolution, {
        basePath: manifest.config.basePath || '',
        buildId: manifest.buildId,
        middlewareMatchers: manifest.routingConfig.routes.middlewareMatchers,
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
    return finalize(
      await renderErrorPage(404, { request, requestContext, tracer, span }),
      request,
      (response) => applyResolutionToThisResponse(response, 404),
    )
  })
}
