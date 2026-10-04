import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

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
import {
  getPrerenderFallbackBlobKey,
  getPrerenderGroupBlobKey,
  getPrerenderGroupTags,
  HtmlBlob,
  type PrerenderGroupBlob,
} from '../../shared/blob-types.cjs'
import { PLUGIN_DIR } from '../constants.js'
import { toComputeResponse, toReqRes } from '../fetch-api-to-req-res.js'
import { getRequestMeta, setVaryHeaders } from '../headers.js'
import {
  getMemoizedKeyValueStoreBackedByRegionalBlobStore,
  setFetchBeforeNextPatchedIt,
  setInMemoryCacheMaxSizeFromNextConfig,
} from '../storage/storage.cjs'

import { cacheOf, finalize, setCacheControl } from './adapter/finalize.js'
import {
  basePath,
  computeOutputsById,
  type InvokeHandlerArg,
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
import type {
  AdapterRequestContext,
  InvokeOptions,
  Produced,
  ProduceRequest,
} from './adapter/types.js'
import { NetlifyAdapterCacheHandler } from './cache-adapter.cjs'
import { invokeEdgeRuntimeOutput } from './edge-runtime-sandbox.js'
import {
  getLogger,
  getRequestContext,
  isBackgroundRevalidationRequest,
} from './request-context.cjs'
import { encodeCacheTag, isAnyTagStaleOrExpired, purgeEdgeCache } from './tags-handler.cjs'
import { getTracer, withActiveSpan } from './tracer.cjs'
import { configureFetchCacheHandler, configureUseCacheHandlers } from './use-cache-handler.js'

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

// like Next's isBot (shared/lib/router/utils/is-bot.ts): the app's `htmlLimitedBots`, which the
// config carries as a regex source, and Googlebot, which renders JavaScript
const htmlLimitedBotsRegex = manifest.config.htmlLimitedBots
  ? new RegExp(String(manifest.config.htmlLimitedBots), 'i')
  : undefined
function isBot(userAgent: string): boolean {
  return (
    /googlebot(?!-)|googlebot$/i.test(userAgent) || Boolean(htmlLimitedBotsRegex?.test(userAgent))
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
  // `onDemandToken`: the regeneration is `res.revalidate()`, which Next reports as on-demand
  { onDemandToken, ...args }: ProduceRequest & { onDemandToken?: string },
): Promise<PrerenderGroupBlob> {
  const invocationId = randomUUID()
  // `allowQuery` (the group key) leaves out params the output pathname already fixes
  // (`/en/docs/[...parts]` has no `nxtPlang`), but Next only splits a catch-all into an array when
  // it gets all of them. Params left as placeholders stay out: they're shared by the group.
  const routeParams = new URLSearchParams(params)
  const requestParams = args.resolution.invocation?.requestMeta.params ?? {}
  for (const [name, value] of Object.entries(requestParams)) {
    const key = `nxtP${name}`
    if (!routeParams.has(key) && !new RegExp(`\\[(?:\\.{3})?${name}]`).test(group.entry.pathname)) {
      for (const item of [value].flat()) {
        routeParams.append(key, item)
      }
    }
  }
  const variants: PrerenderGroupBlob['variants'] = {}
  let postponed: string | undefined
  let entryHtml: string | undefined
  // a PPR shell is what Next caches, as the adapter PPR docs persist it: the response of a minimal
  // mode render isn't only the shell (in test mode it starts with the PPR boundary sentinel)
  const captureEntry: InvokeOptions['onCacheEntry'] = (entry) => {
    if (entry.value?.kind === 'APP_PAGE') {
      const { postponed: entryPostponed, html } = entry.value
      postponed = entryPostponed
      try {
        entryHtml = html?.toUnchunkedString?.()
      } catch {
        // a streamed (dynamic) render has no cached shell, the response has it all
      }
    }
  }
  // the entry first: its render fills Next's response cache for the other variants
  for (const member of [group.entry, ...group.members.filter((item) => item !== group.entry)]) {
    const output = computeOutputsById.get(member.parentOutputId)
    if (!output) {
      continue
    }
    const url = new URL(member.pathname, args.request.url)
    url.search = routeParams.toString()
    const memberRequest = new Request(url, {
      headers: onDemandToken ? { 'x-prerender-revalidate': onDemandToken } : {},
    })
    const response = await finalize(
      await invokeHandler(
        output,
        { ...args, request: memberRequest, resolution: {} },
        {
          invocationId,
          raw: true,
          ...(member === group.entry && { onCacheEntry: captureEntry }),
        },
      ),
      memberRequest,
    )
    const body = Buffer.from(await response.arrayBuffer())
    variants[member.pathname] = {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: (member === group.entry && postponed !== undefined && entryHtml !== undefined
        ? Buffer.from(entryHtml)
        : body
      ).toString('base64'),
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
      basePath,
    ),
    variants,
    postponed,
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

async function getPrerenderGroupPostponed(
  group: Required<PrerenderGroup>,
  { resolution }: ProduceRequest,
): Promise<string | undefined> {
  const params = getPrerenderGroupQuery(
    group.entry,
    resolution.resolvedQuery ?? resolution.invocation?.requestMeta.query,
  )
  const paramsString = params.toString()
  const store = getMemoizedKeyValueStoreBackedByRegionalBlobStore({ consistency: 'strong' })
  const blob = await store.get<PrerenderGroupBlob>(
    getPrerenderGroupBlobKey(
      paramsString ? `${group.entry.pathname}?${paramsString}` : group.entry.pathname,
    ),
    'prerenderGroup.get',
  )
  if (blob?.postponed !== undefined || !group.entry.fallbackShell) {
    return blob?.postponed
  }
  const shell = await store.get<PrerenderGroupBlob>(
    getPrerenderFallbackBlobKey(group.entry.pathname),
    'prerenderFallback.get',
  )
  return shell?.postponed
}

async function servePrerenderGroup(
  variant: PrerenderOutput,
  group: Required<PrerenderGroup>,
  args: ProduceRequest,
  onDemand?: OnDemandRevalidate,
): Promise<Produced | undefined> {
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
      return {
        kind: 'final',
        response: new Response('This page could not be found', { status: 404 }),
      }
    }
    blob = await regeneratePrerenderGroup(groupKey, group, params, {
      ...args,
      onDemandToken: group.entry.bypassToken,
    })
    // `res.revalidate()` resolves with this response: callers expect the CDN to be fresh by then
    await purgeEdgeCache(blob.tags.map(encodeCacheTag))
    nextCache = 'MISS'
  } else if (blob) {
    const age = (Date.now() - blob.lastModified) / 1000
    const tags = await isAnyTagStaleOrExpired(blob.tags, blob.lastModified)
    const expired = tags.expired || (blob.expire !== undefined && age > blob.expire)
    const stale = tags.stale || (blob.revalidate !== false && age > blob.revalidate)
    if (expired || (stale && isBackgroundRevalidationRequest(request))) {
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

  if (
    !blob &&
    !onDemand &&
    group.entry.fallbackShell &&
    // like Next, crawlers get the page rendered instead
    !isBot(request.headers.get('user-agent') ?? '')
  ) {
    // like a CDN serving the prerender's fallback: the client then asks for the path's data, which
    // generates the group
    const shell = await store.get<PrerenderGroupBlob>(
      getPrerenderFallbackBlobKey(group.entry.pathname),
      'prerenderFallback.get',
    )
    const shellVariant = shell?.variants[variant.pathname]
    const isPartialFallback = shellVariant && shell?.postponed !== undefined
    if (isPartialFallback) {
      // PPR partial fallback: upgrade the shell to the path's own group in the background, a
      // segment prefetch served the shell's segment included (the router retries it)
      requestContext.trackBackgroundWork(
        regeneratePrerenderGroup(groupKey, group, params, args).then(
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          () => {},
          (error) => getLogger().withError(error).error('prerender group regeneration error'),
        ),
      )
    }
    if (isPartialFallback && variant === group.entry && group.entry.resumeHeaders) {
      // resume the shell for this request
      return resumePrerender(
        { variant, entry: group.entry, postponed: shell.postponed as string, stored: shellVariant },
        args,
      )
    }
    if (shellVariant) {
      const response = new Response(
        request.method === 'HEAD' ? null : Buffer.from(shellVariant.body, 'base64'),
        { status: shellVariant.status, headers: shellVariant.headers },
      )
      return { kind: 'shell', response }
    }
  }

  // a PPR group's `.rsc` has no body of its own (its output's fallback has no file): it's a resume
  if (
    blob &&
    !blob.variants[variant.pathname] &&
    blob.postponed !== undefined &&
    group.entry.resumeHeaders
  ) {
    const resumed = await resumePrerender(
      { variant, entry: group.entry, postponed: blob.postponed },
      args,
    )
    if (resumed) {
      return resumed
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

  if (blob.postponed !== undefined && group.entry.resumeHeaders) {
    const resumed = await resumePrerender(
      { variant, entry: group.entry, postponed: blob.postponed, stored },
      args,
    )
    if (resumed) {
      return resumed
    }
  }

  const response = new Response(
    request.method === 'HEAD' ? null : Buffer.from(stored.body, 'base64'),
    { status: stored.status, headers: stored.headers },
  )
  response.headers.set('x-nextjs-cache', nextCache)
  return {
    kind: 'next',
    response,
    cache: {
      lastModified: nextCache === 'MISS' ? undefined : blob.lastModified,
      tags: stored.headers['x-next-cache-tags'] ? undefined : blob.tags.map(encodeCacheTag),
      // the 404 caching heuristics read it for a prerendered 404 page
      revalidate: blob.revalidate,
    },
  }
}

/**
 * PPR: the stored shell is only the start of the page, the rest comes from resuming its postponed
 * render, streamed after it as one response (and a dynamic RSC request is a resume on its own). The
 * result is per request, so it isn't cached.
 */
async function resumePrerender(
  {
    variant,
    entry,
    postponed,
    stored,
  }: {
    variant: PrerenderOutput
    entry: PrerenderOutput
    postponed: string
    stored?: PrerenderGroupBlob['variants'][string]
  },
  args: ProduceRequest,
): Promise<Produced | undefined> {
  const { request } = args
  const { rsc } = manifest
  const isRSCRequest = Boolean(rsc) && request.headers.get(rsc.header) === '1'
  const isPrefetch = isRSCRequest && request.headers.get(rsc.prefetchHeader) === '1'
  const output = computeOutputsById.get(variant.parentOutputId)
  if (!output || isPrefetch || (variant !== entry && !isRSCRequest)) {
    return
  }
  const resume = { postponed, headers: entry.resumeHeaders }
  if (isRSCRequest) {
    return invokeHandler(output, args, { resume })
  }
  if (!stored) {
    return
  }

  // the shell goes out right away, the resumed part streams after it once Next produces it
  const shell = Buffer.from(stored.body, 'base64')
  const body =
    request.method === 'HEAD'
      ? null
      : new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(shell)
            try {
              const resumed = await finalize(await invokeHandler(output, args, { resume }), request)
              if (resumed.body) {
                const reader = resumed.body.getReader()
                for (;;) {
                  const { done, value } = await reader.read()
                  if (done) {
                    break
                  }
                  controller.enqueue(value)
                }
              }
            } catch (error) {
              // the shell is already out, so the page can only end short
              getLogger().withError(error).error('PPR resume error')
            }
            controller.close()
          },
        })
  return {
    kind: 'resume',
    response: new Response(body, { status: stored.status, headers: stored.headers }),
  }
}

type NodeHandlerFn = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx?: { waitUntil?: (prom: Promise<void>) => void; requestMeta?: RequestMeta },
) => Promise<void>

// Netlify Adapter machinery (just for integration tests resetting global state in-between tests)
// TODO(adapter): figure out something better, we should not expose test-only globals in the actual adapter code
const NetlifyAdapterTestReset = Symbol.for('@netlify/adapter-test-reset')

// Cache loaded handler functions
const nodeHandlerCache = new Map<string, NodeHandlerFn>()

const extendedGlobalThis = globalThis as typeof globalThis & {
  // just for reset in-between tests, see tests/utils/fixture.ts
  [NetlifyAdapterTestReset]: () => void
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

async function invokeHandler(
  { id, entrypoint, runtime, sourcePage }: InvokeHandlerArg,
  { tracer, request, requestContext, resolution, span, invokeStatus }: ProduceRequest,
  { invocationId, raw, resume, postponed, onCacheEntry }: InvokeOptions = {},
): Promise<Produced> {
  span?.setAttribute('matched.sourcePage', sourcePage)
  span?.setAttribute('matched.runtime', runtime)
  return await withActiveSpan(tracer, 'invoke route handler', async (invokeSpan) => {
    if (runtime === 'edge') {
      try {
        const response = await invokeEdgeRuntimeOutput({
          outputId: id,
          request,
          requestContext,
          manifest,
          query: resolution.resolvedQuery,
          routeParams: resolution.invocation?.requestMeta.params,
          // only `initURL`: the rest of what node outputs get (`query`, `params`) is folded into the
          // URL the sandbox invokes with, and as request meta it'd end up in `resolvedUrl` too
          requestMeta: { initURL: resolution.invocation?.requestMeta.initURL ?? request.url },
        })
        return { kind: 'final' as const, response }
      } catch (error) {
        console.error('edge runtime output error', error)
        getLogger().withError(error).error('edge runtime output error')
        invokeSpan?.setAttribute('http.status_code', 500)
        return {
          kind: 'final' as const,
          response: new Response('Internal Server Error', { status: 500 }),
        }
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
      for (const [key, value] of Object.entries(resume?.headers ?? {})) {
        handlerRequest.headers.set(key, value)
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
          ...(invocation?.requestMeta ?? { initURL: request.url }),
          render404,
          revalidate,
          minimalMode: true,
          ...((resume ?? postponed) && { postponed: resume?.postponed ?? postponed }),
          ...(onCacheEntry && {
            onCacheEntryV2: async (entry: Parameters<typeof onCacheEntry>[0]) => {
              onCacheEntry(entry)
              return false
            },
          }),
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
        return {
          kind: 'final' as const,
          response: new Response(response.body?.pipeThrough(untilRendered), response),
        }
      }

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

      return {
        kind: 'next' as const,
        response: new Response(
          response.body?.pipeThrough(keepOpenUntilNextFullyRendered),
          response,
        ),
      }
    } catch (error) {
      console.error('route handler error', error)
      getLogger().withError(error).error('route handler error')
      invokeSpan?.setAttribute('http.status_code', 500)
      return {
        kind: 'final' as const,
        response: new Response('Internal Server Error', { status: 500 }),
      }
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
