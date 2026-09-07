import { ResolveRoutesResult } from '@next/routing'
import { detectDomainLocale } from 'next-with-adapters/dist/shared/lib/i18n/detect-domain-locale.js'
import { getLocaleRedirect } from 'next-with-adapters/dist/shared/lib/i18n/get-locale-redirect.js'

export { resolveRoutes, responseToMiddlewareResult } from '@next/routing'
export type { ResolveRoutesParams, ResolveRoutesResult } from '@next/routing'

// @next/routing stopped exporting this from its package index, so keep a copy for building
// the URL that middleware sees (Next.js normalizes data URLs before invoking middleware).
export function normalizeNextDataUrl(url: URL, basePath: string, buildId: string): URL {
  const normalized = new URL(url.toString())
  const prefix = `${basePath}/_next/data/${buildId}/`
  if (normalized.pathname.startsWith(prefix)) {
    let page = normalized.pathname.slice(prefix.length)
    if (page.endsWith('.json')) {
      page = page.slice(0, -5)
    }
    normalized.pathname = page === 'index' ? basePath || '/' : `${basePath}/${page}`
  }
  return normalized
}

export type I18nForRouting = {
  locales: string[]
  defaultLocale: string
  localeDetection?: false
  domains?: Array<{ domain: string; defaultLocale: string; http?: true; locales?: string[] }>
}

/**
 * Next's router adds the default locale to `/_next/data/<buildId>/page.json` requests missing one
 * (router-utils/resolve-routes `middleware_next_data`), `resolveRoutes` skips i18n for data
 * requests entirely: the mandatory-locale middleware matchers and dynamic data routes never match.
 * Do that step here. `/api/` requests, which `resolveRoutes` also skips, are handled by patching the
 * matcher regex at build time instead (see fixAdapterOutputForNextRouting), because the routing
 * tables only know unprefixed API pathnames.
 */
export function addDefaultLocaleForRouting(
  url: URL,
  { basePath, buildId, i18n }: { basePath: string; buildId: string; i18n?: I18nForRouting | null },
  headers?: Headers,
): URL {
  if (!i18n) {
    return url
  }
  const pathname =
    basePath && url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length)
      : url.pathname
  const domainLocale = detectDomainLocale(i18n.domains, url.hostname)
  const defaultLocale = domainLocale?.defaultLocale ?? i18n.defaultLocale
  const startsWithLocale = (path: string) => {
    const segment = path
      .split('/')[1]
      ?.replace(/\.json$/, '')
      .toLowerCase()
    return i18n.locales.some((locale) => locale.toLowerCase() === segment)
  }

  // `/` alone: the lib prefixes the detected-or-default locale and 308s `/` to it (`/en`). Next only
  // redirects when the detected locale (accept-language, NEXT_LOCALE cookie, domain) differs from
  // the default and serves the default locale's root directly. Leave detected redirects to the lib
  // (it runs middleware first, so we can't resolve twice) and route the rest as the default root.
  if (pathname === '' || pathname === '/') {
    const redirect = getLocaleRedirect({
      defaultLocale,
      domainLocale,
      headers: headers ? Object.fromEntries(headers) : undefined,
      nextConfig: {
        basePath,
        i18n: i18n as Parameters<typeof getLocaleRedirect>[0]['nextConfig']['i18n'],
      },
      urlParsed: { hostname: url.hostname, pathname: '/' },
    })
    if (redirect) {
      return url
    }
    const result = new URL(url)
    result.pathname = `${basePath}/${defaultLocale}`
    return result
  }

  const dataPrefix = `/_next/data/${buildId}/`
  if (!pathname.startsWith(dataPrefix)) {
    return url
  }
  const rest = pathname.slice(dataPrefix.length)
  if (startsWithLocale(`/${rest}`)) {
    return url
  }
  const result = new URL(url)
  result.pathname = `${basePath}${dataPrefix}${rest === 'index.json' ? `${defaultLocale}.json` : `${defaultLocale}/${rest}`}`
  return result
}

/**
 * Next keys the Pages Router root output as `/index` while requests come in as `/` (and
 * `matchesPathname` is exact), so register the root under both. adapter-k8s does the same.
 */
type RoutingBasics = { basePath: string; buildId: string }

export function isNextDataPathname(
  pathname: string,
  { basePath, buildId }: RoutingBasics,
): boolean {
  return pathname.startsWith(`${basePath}/_next/data/${buildId}/`)
}

/**
 * Next's router marks `/_next/data/<buildId>/…` requests with this header before middleware and
 * route modules see them, both key data-request behaviour (`x-nextjs-rewrite`,
 * `x-nextjs-matched-path`) off the header rather than the URL.
 */
export function setNextDataHeader(headers: Headers, url: URL, routing: RoutingBasics): Headers {
  if (isNextDataPathname(url.pathname, routing)) {
    headers.set('x-nextjs-data', '1')
  }
  return headers
}

/**
 * `@next/routing` checks `dynamicRoutes` before the filesystem after an `afterFiles` rewrite,
 * Next's router does the opposite: a rewrite to a static page shadowed by a dynamic route
 * (`/rewrite-1 → /ssr-page` next to `pages/[id]`) resolves to the dynamic one. Prefer the static
 * output when the rewritten pathname is one.
 */
export function preferStaticPathnameAfterRewrite(
  resolution: ResolveRoutesResult,
  url: URL,
  {
    pathnames,
    basePath,
    buildId,
    i18n,
  }: RoutingBasics & { pathnames: Iterable<string>; i18n: I18nForRouting | null },
): ResolveRoutesResult {
  const { routeMatches, invocationTarget, resolvedPathname } = resolution
  if (!routeMatches || !invocationTarget || !resolvedPathname?.includes('[')) {
    return resolution
  }
  const known = pathnames instanceof Set ? pathnames : new Set(pathnames)
  const stripBasePath = (pathname: string) =>
    basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) || '/' : pathname

  // for data requests this is the page path (see getInvocationUrl)
  const candidates = [invocationTarget.pathname]
  if (i18n) {
    const rest = stripBasePath(invocationTarget.pathname)
    const [, first = ''] = rest.split('/')
    const locale = i18n.locales.find((value) => value.toLowerCase() === first.toLowerCase())
    candidates.push(
      locale
        ? `${basePath}${rest.slice(locale.length + 1) || '/'}`
        : `${basePath}/${i18n.defaultLocale}${rest === '/' ? '' : rest}`,
    )
  }
  if (isNextDataPathname(url.pathname, { basePath, buildId })) {
    candidates.unshift(
      ...candidates.map((candidate) => {
        const rest = stripBasePath(candidate)
        return `${basePath}/_next/data/${buildId}/${rest === '/' ? 'index' : rest.slice(1)}.json`
      }),
    )
  }

  const staticPathname = candidates.find((candidate) => known.has(candidate))
  if (!staticPathname) {
    return resolution
  }
  // drop the route params the dynamic match added to the query
  const query = { ...invocationTarget.query }
  for (const key of Object.keys(routeMatches)) {
    delete query[key]
  }
  return {
    ...resolution,
    resolvedPathname: staticPathname,
    routeMatches: undefined,
    resolvedQuery: query,
    invocationTarget: { ...invocationTarget, query },
  }
}

export function getPathnameAliases(pathname: string, basePath: string): string[] {
  return pathname === `${basePath}/index` ? [pathname, basePath || '/'] : [pathname]
}

/**
 * URL to invoke for a matched route. `invocationTarget` carries the concrete pathname + query after
 * rewrites (routing rules or middleware). For data requests resolved through dynamic routes
 * @next/routing returns the normalized page pathname, but Next.js detects data requests from the
 * `/_next/data/` prefix, so re-add it.
 */
export function getInvocationUrl(
  request: Request,
  resolution: ResolveRoutesResult,
  {
    basePath,
    buildId,
    trailingSlash,
  }: { basePath: string; buildId: string; trailingSlash?: boolean },
): URL {
  const url = new URL(request.url)
  if (!resolution.invocationTarget) {
    return url
  }
  const dataPrefix = `${basePath}/_next/data/${buildId}/`
  const isDataRequest = url.pathname.startsWith(dataPrefix)

  let { pathname } = resolution.invocationTarget
  const { query } = resolution.invocationTarget
  if (isDataRequest && !pathname.startsWith(dataPrefix)) {
    const page =
      basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname
    pathname = `${dataPrefix}${page === '' || page === '/' ? 'index' : page.slice(1)}.json`
  }

  // undo the synthetic `/:path+/` -> `/$1` rewrite from fixAdapterOutputForNextRouting,
  // Next.js keeps the trailing slash in req.url when trailingSlash is enabled
  if (
    trailingSlash &&
    url.pathname.endsWith('/') &&
    !pathname.endsWith('/') &&
    !isDataRequest &&
    pathname !== basePath
  ) {
    pathname += '/'
  }

  url.pathname = pathname
  url.search = ''
  for (const [key, valueOrValues] of Object.entries(query)) {
    for (const value of Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues]) {
      url.searchParams.append(key, value)
    }
  }
  return url
}

export function applyResolutionToResponse(
  request: Request,
  resolution: ResolveRoutesResult,
  response: Response,
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
      if (normalizedKey === 'location' && resolution.redirect) {
        headers.set(key, resolution.redirect.url.toString())
        continue
      }
      if (request.headers.get(key) === value) {
        // skip echoing request headers back in response
        continue
      }
      headers.set(key, value)
    }
  }

  const finalResponse = new Response(response.body, {
    status: explicitStatus ?? resolution.status ?? response.status,
    statusText: response.statusText,
    headers,
  })

  return finalResponse
}
