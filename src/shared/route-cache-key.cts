import { createHash } from 'node:crypto'

// Mirror of Next.js' `server/lib/route-cache-key.ts` (added in 15.5.27 / 16.3.8).
// From those versions on, the incremental cache scopes every response cache key by the owning route
// before handing it to a custom cache handler, so we must produce the same key when seeding
// prerendered content at build time. Keep this in sync with Next; `route-cache-key.test.ts` pins the
// format against values captured from a real patched build.
// https://github.com/vercel/next.js/commit/719e4c67d6e92df60246f95e1d96e2dd60789a52
// https://github.com/vercel/next.js/pull/99482

export const ROUTE_CACHE_DIRECTORY = 'route-cache'

/**
 * Next versions whose incremental cache scopes response keys by route (i.e. where we must seed and
 * look up entries under `getRouteCacheKey`).
 */
export const ROUTE_CACHE_KEY_NEXT_VERSION_RANGE =
  '>=15.5.27 <15.6.0-0 || >=16.3.8 <16.4.0-0 || >=16.4.0-canary.54'

// Next's `RouteKind` enum also has `PAGES_API` and `IMAGE`, but only these three can appear in a
// route-cache key: `IMAGE` throws before key derivation ("Images must use the image optimizer
// cache"), `PAGES_API` isn't stored in the response cache, and `FETCH` uses the fetch cache (a plain
// key, not route-scoped). `isRouteCacheOwner` derives the same three from the prerender manifest's
// dataRoute (null -> APP_ROUTE, .json -> PAGES, .rsc -> APP_PAGE).
export type RouteCacheKind = 'PAGES' | 'APP_PAGE' | 'APP_ROUTE'

export interface RouteCacheOwner {
  kind: RouteCacheKind
  /** The route that owns the entry: Pages route pathname / App page, e.g. `/post/[id]`. */
  sourceRoute: string
}

// Matches Next's `isDynamicRoute` closely enough for `normalizePagePath`: a path segment wrapped in
// square brackets (`[id]`, `[...slug]`, `[[...slug]]`).
const DYNAMIC_SEGMENT = /\/\[[^/]+?](?=\/|$)/

function ensureLeadingSlash(page: string): string {
  return page.startsWith('/') ? page : `/${page}`
}

/**
 * Port of Next's `normalizePagePath` (`shared/lib/page-path/normalize-page-path`). `getRouteCacheKey`
 * applies it to the request pathname, so we must match it exactly.
 */
export function normalizePagePath(page: string): string {
  return /^\/index(\/|$)/.test(page) && !DYNAMIC_SEGMENT.test(page)
    ? `/index${page}`
    : page === '/'
      ? '/index'
      : ensureLeadingSlash(page)
}

/**
 * The `sourceRoute` Next scopes a cache entry by (`getResponseCacheOwner`): the Pages route pathname
 * for Pages Router, but the App Router *module page* for App Router — i.e. the source route plus its
 * segment suffix (`/page` for pages, `/route` for route handlers), matching the app-paths manifest.
 * `baseSourceRoute` is the source route without that suffix (a prerender manifest `srcRoute`, or the
 * route itself for a static entry).
 */
export function getOwnerSourceRoute(baseSourceRoute: string, kind: RouteCacheKind): string {
  const base = baseSourceRoute.startsWith('/') ? baseSourceRoute : `/${baseSourceRoute}`
  const suffix = kind === 'APP_PAGE' ? 'page' : kind === 'APP_ROUTE' ? 'route' : undefined
  if (!suffix) {
    return base
  }
  return base === '/' ? `/${suffix}` : `${base}/${suffix}`
}

function hashSourceRoute(sourceRoute: string): string {
  return createHash('sha256').update(sourceRoute).digest('hex')
}

/**
 * Port of Next's `getRouteCacheKey`. Produces the scoped storage key a patched Next passes to the
 * cache handler at runtime, so seeded entries are found instead of silently missing.
 */
export function getRouteCacheKey(pathname: string, owner: RouteCacheOwner): string {
  return `/${ROUTE_CACHE_DIRECTORY}/${owner.kind}/${hashSourceRoute(owner.sourceRoute)}/$${normalizePagePath(
    pathname,
  )}`
}

/** Whether a runtime cache key is a scoped route-cache key (patched Next) vs a plain pathname. */
export function isRouteCacheKey(key: string): boolean {
  return key.startsWith(`/${ROUTE_CACHE_DIRECTORY}/`)
}

/**
 * Recover the request pathname from a scoped route-cache key, for deriving path-based cache tags.
 * `/route-cache/PAGES/<hash>/$/post/1` -> `/post/1`; the `$/index` root maps back to `/`.
 * Returns the key unchanged if it isn't a scoped key.
 */
export function routeCacheKeyToPathname(key: string): string {
  if (!isRouteCacheKey(key)) {
    return key
  }
  const marker = key.indexOf('/$/')
  if (marker === -1) {
    return key
  }
  const pathname = key.slice(marker + 2)
  return pathname === '/index' ? '/' : pathname
}
