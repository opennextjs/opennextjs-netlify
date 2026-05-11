import type { EdgeFunction } from 'https://edge.netlify.com'

// These are copied from next/dist/build. This file gets copied as part of the next
// runtime build and can't reference the next package directly.
//
// Latest types at https://github.com/vercel/next.js/blob/4a2df3c3752aeddc50fd5ab053440eccf71ae50b/packages/next/src/build/index.ts#L140
export declare type SsgRoute = {
  initialRevalidateSeconds: number | false
  srcRoute: string | null
  dataRoute: string | null
}
export declare type DynamicSsgRoute = {
  routeRegex: string
  fallback: string | null | false
  dataRoute: string | null
  dataRouteRegex: string
}
export declare type PrerenderManifest = {
  version: 3
  routes: {
    [route: string]: SsgRoute
  }
  dynamicRoutes: {
    [route: string]: DynamicSsgRoute
  }
  notFoundRoutes: string[]
}

const noop = () => {}

// Ensure that routes with and without a trailing slash map to different ODB paths
const rscifyPath = (route: string) => {
  if (route.endsWith('/')) {
    return route.slice(0, -1) + '.rsc/'
  }
  return route + '.rsc'
}

export const getRscDataRouter = ({ routes: staticRoutes, dynamicRoutes }: PrerenderManifest): EdgeFunction => {
  const staticRouteSet = new Set(
    Object.entries(staticRoutes)
      .filter(([, { dataRoute }]) => dataRoute?.endsWith('.rsc'))
      .map(([route]) => route),
  )

  const dynamicRouteMatcher = Object.values(dynamicRoutes)
    .filter(({ dataRoute }) => dataRoute?.endsWith('.rsc'))
    .map(({ routeRegex }) => new RegExp(routeRegex))

  const matchesDynamicRscDataRoute = (pathname: string) => {
    return dynamicRouteMatcher.some((matcher) => matcher.test(pathname))
  }

  const matchesStaticRscDataRoute = (pathname: string) => {
    const key = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
    return staticRouteSet.has(key)
  }

  const matchesRscRoute = (pathname: string) => {
    return matchesStaticRscDataRoute(pathname) || matchesDynamicRscDataRoute(pathname)
  }

  return (request, context) => {
    const debug = request.headers.has('x-next-debug-logging')
    const log = debug ? (...args: unknown[]) => console.log(...args) : noop
    const url = new URL(request.url)
    // If this is a static RSC request, rewrite to the data route.
    // Authenticated RSC requests can contain user-specific flight payloads. If
    // a broad static catch-all route matches a dynamic page, rewriting an
    // authenticated request to a cacheable `.rsc` route can allow the first
    // user's payload to be reused for later users by the CDN/ODB cache. Let
    // authenticated requests continue to the origin route instead.
    if (request.headers.get('rsc') === '1') {
      log('Is rsc request')
      if (request.headers.has('cookie') || request.headers.has('authorization')) {
        log('Skipping RSC data rewrite for authenticated request')
        return
      }
      if (matchesRscRoute(url.pathname)) {
        request.headers.set('x-rsc-route', url.pathname)
        const target = rscifyPath(url.pathname)
        log('Rewriting to', target)
        return context.rewrite(target)
      }
    }
  }
}
