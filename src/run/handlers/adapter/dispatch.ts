// L3: what a resolved request is for (an output, its prerender group, an error page, or an answer
// dispatch gives itself) and producing it, see docs/request-layers.md.
import type { ResolveRoutesResult } from '../../../adapter-runtime-shared/next-routing.js'

import { invokeHandler } from './invoke.js'
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
} from './manifest.js'
import {
  getPrerenderGroupPostponed,
  type OnDemandRevalidate,
  servePrerenderGroup,
} from './prerender-store.js'
import { serverStaticFile } from './static-file.js'
import type { InvokeOptions, Produced, ProduceRequest } from './types.js'
import { getPrerenderVariant } from './variants.js'

export function produceOutput(
  routed: RoutedOutput,
  args: ProduceRequest,
  options?: InvokeOptions,
): Promise<Produced> {
  return routed.kind === 'compute'
    ? invokeHandler(routed.output, args, options)
    : serverStaticFile(routed.file, args)
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

/**
 * What a request resolved to `pathname` is for: an output (served from its prerender group when
 * there is one to serve), an error page, or an answer dispatch gives itself.
 */
export type Target =
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

export function dispatch(
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
  // POST to a page URL: the prerender's `bypassFor` lists the requests Next renders instead
  // (actions by their header or form content-type).
  if (
    !['GET', 'HEAD'].includes(request.method) &&
    readOnlyPathnames.has(pathname) &&
    !(prerendersByPathname.get(pathname)?.bypassFor ?? []).some((has) =>
      matchesHas(has, request, url),
    ) &&
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

export async function produceTarget(
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
      return answerFailure(served, args)
    }
  }
  return answerFailure(
    await produceOutput(
      output,
      args,
      postponedFrom && { postponed: await getPrerenderGroupPostponed(postponedFrom, args) },
    ),
    args,
  )
}

// a render that failed before its headers gets the 500 page, like Next's router renders it
function answerFailure(produced: Produced, args: ProduceRequest): Promise<Produced> | Produced {
  return produced.kind === 'failed' ? renderErrorPage(500, args) : produced
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
export async function renderErrorPage(
  status: 404 | 500,
  { request, requestContext, tracer, span, nextCallbacks }: Omit<ProduceRequest, 'resolution'>,
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
    nextCallbacks,
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
export function isStatusPageRequest(
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

export function isNotFoundPageRequest(request: Request, resolvedPathname: string): boolean {
  return isStatusPageRequest(request, resolvedPathname, 404)
}

// Next's router answers a no-match for `_next/static` assets with plain text instead of rendering
// the 404 page (router-server "404 case"). It does the same for non-HTML `sec-fetch-dest` requests,
// but upstream tests expect the HTML 404 for those when deployed (Vercel's CDN behaviour), so only
// the static-asset rule is mirrored.
export function isPlainNotFoundRequest(url: URL): boolean {
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
