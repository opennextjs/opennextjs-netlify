/**
 * Various router utils ported to Deno from Next.js source
 * Licence: https://github.com/vercel/next.js/blob/7280c3ced186bb9a7ae3d7012613ef93f20b0fa9/license.md
 *
 * Some types have been re-implemented to be more compatible with Deno or avoid chains of dependent files
 */

import type { Key } from '../vendor/deno.land/x/path_to_regexp@v6.2.1/index.ts'

import { compile, pathToRegexp } from '../vendor/deno.land/x/path_to_regexp@v6.2.1/index.ts'
import { getCookies } from '../vendor/deno.land/std@0.175.0/http/cookie.ts'

/*
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ Inlined/re-implemented types                                            │
  └─────────────────────────────────────────────────────────────────────────┘
 */
export interface ParsedUrlQuery {
  [key: string]: string | string[]
}

export interface Params {
  [param: string]: any
}

export type RouteHas =
  | {
      type: 'header' | 'query' | 'cookie'
      key: string
      value?: string
    }
  | {
      type: 'host'
      key?: undefined
      value: string
    }

export type Rewrite = {
  source: string
  destination: string
  basePath?: false
  locale?: false
  has?: RouteHas[]
  missing?: RouteHas[]
  regex: string
}

export type Header = {
  source: string
  basePath?: false
  locale?: false
  headers: Array<{ key: string; value: string }>
  has?: RouteHas[]
  missing?: RouteHas[]
  regex: string
}

export type Redirect = {
  source: string
  destination: string
  basePath?: false
  locale?: false
  has?: RouteHas[]
  missing?: RouteHas[]
  statusCode?: number
  permanent?: boolean
  regex: string
}

export type DynamicRoute = {
  page: string
  regex: string
  namedRegex?: string
  routeKeys?: { [key: string]: string }
}

export type RoutesManifest = {
  basePath: string
  redirects: Redirect[]
  headers: Header[]
  rewrites: {
    beforeFiles: Rewrite[]
    afterFiles: Rewrite[]
    fallback: Rewrite[]
  }
  dynamicRoutes: DynamicRoute[]
}

/*
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ packages/next/src/shared/lib/escape-regexp.ts                           │
  └─────────────────────────────────────────────────────────────────────────┘
 */
// regexp is based on https://github.com/sindresorhus/escape-string-regexp
const reHasRegExp = /[|\\{}()[\]^$+*?.-]/
const reReplaceRegExp = /[|\\{}()[\]^$+*?.-]/g

export function escapeStringRegexp(str: string) {
  // see also: https://github.com/lodash/lodash/blob/2da024c3b4f9947a48517639de7560457cd4ec6c/escapeRegExp.js#L23
  if (reHasRegExp.test(str)) {
    return str.replace(reReplaceRegExp, '\\$&')
  }

  return str
}

/*
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ packages/next/src/shared/lib/router/utils/querystring.ts                │
  └─────────────────────────────────────────────────────────────────────────┘
 */
export function searchParamsToUrlQuery(searchParams: URLSearchParams): ParsedUrlQuery {
  const query: ParsedUrlQuery = {}

  searchParams.forEach((value, key) => {
    if (typeof query[key] === 'undefined') {
      query[key] = value
    } else if (Array.isArray(query[key])) {
      ;(query[key] as string[]).push(value)
    } else {
      query[key] = [query[key] as string, value]
    }
  })

  return query
}

/*
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ packages/next/src/shared/lib/router/utils/parse-url.ts                  │
  └─────────────────────────────────────────────────────────────────────────┘
 */
interface ParsedUrl {
  hash: string
  hostname?: string | null
  href: string
  pathname: string
  port?: string | null
  protocol?: string | null
  query: ParsedUrlQuery
  search: string
}

export function parseUrl(url: string): ParsedUrl {
  const parsedURL = url.startsWith('/') ? new URL(url, 'http://n') : new URL(url)

  return {
    hash: parsedURL.hash,
    hostname: parsedURL.hostname,
    href: parsedURL.href,
    pathname: parsedURL.pathname,
    port: parsedURL.port,
    protocol: parsedURL.protocol,
    query: searchParamsToUrlQuery(parsedURL.searchParams),
    search: parsedURL.search,
  }
}

/*
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ packages/next/src/shared/lib/router/utils/prepare-destination.ts        │
  │ — Changed to use WHATWG Fetch `Request` instead of                      │
  │ `http.IncomingMessage`.                                                 │
  └─────────────────────────────────────────────────────────────────────────┘
 */
export function matchHas(
  req: Pick<Request, 'headers' | 'url'>,
  query: Params,
  has: RouteHas[] = [],
  missing: RouteHas[] = [],
): false | Params {
  const params: Params = {}
  const cookies = getCookies(req.headers)
  const url = new URL(req.url)
  const hasMatch = (hasItem: RouteHas) => {
    let value: undefined | string | null
    let key = hasItem.key

    switch (hasItem.type) {
      case 'header': {
        key = hasItem.key.toLowerCase()
        value = req.headers.get(key)
        break
      }
      case 'cookie': {
        value = cookies[hasItem.key]
        break
      }
      case 'query': {
        value = query[hasItem.key]
        break
      }
      case 'host': {
        value = url.hostname
        break
      }
      default: {
        break
      }
    }
    if (!hasItem.value && value && key) {
      params[getSafeParamName(key)] = value

      return true
    } else if (value) {
      const matcher = new RegExp(`^${hasItem.value}$`)
      const matches = Array.isArray(value)
        ? value.slice(-1)[0].match(matcher)
        : value.match(matcher)

      if (matches) {
        if (Array.isArray(matches)) {
          if (matches.groups) {
            Object.keys(matches.groups).forEach((groupKey) => {
              params[groupKey] = matches.groups![groupKey]
            })
          } else if (hasItem.type === 'host' && matches[0]) {
            params.host = matches[0]
          }
        }
        return true
      }
    }
    return false
  }

  const allMatch = has.every((item) => hasMatch(item)) && !missing.some((item) => hasMatch(item))

  if (allMatch) {
    return params
  }
  return false
}

export function compileNonPath(value: string, params: Params): string {
  if (!value.includes(':')) {
    return value
  }

  for (const key of Object.keys(params)) {
    if (value.includes(`:${key}`)) {
      value = value
        .replace(new RegExp(`:${key}\\*`, 'g'), `:${key}--ESCAPED_PARAM_ASTERISKS`)
        .replace(new RegExp(`:${key}\\?`, 'g'), `:${key}--ESCAPED_PARAM_QUESTION`)
        .replace(new RegExp(`:${key}\\+`, 'g'), `:${key}--ESCAPED_PARAM_PLUS`)
        .replace(new RegExp(`:${key}(?!\\w)`, 'g'), `--ESCAPED_PARAM_COLON${key}`)
    }
  }
  value = value
    .replace(/(:|\*|\?|\+|\(|\)|\{|\})/g, '\\$1')
    .replace(/--ESCAPED_PARAM_PLUS/g, '+')
    .replace(/--ESCAPED_PARAM_COLON/g, ':')
    .replace(/--ESCAPED_PARAM_QUESTION/g, '?')
    .replace(/--ESCAPED_PARAM_ASTERISKS/g, '*')
  // the value needs to start with a forward-slash to be compiled
  // correctly
  return compile(`/${value}`, { validate: false })(params).slice(1)
}

export function prepareDestination(args: {
  appendParamsToQuery: boolean
  destination: string
  params: Params
  query: ParsedUrlQuery
}) {
  const query = Object.assign({}, args.query)
  delete query.__nextLocale
  delete query.__nextDefaultLocale
  delete query.__nextDataReq

  let escapedDestination = args.destination

  for (const param of Object.keys({ ...args.params, ...query })) {
    escapedDestination = escapeSegment(escapedDestination, param)
  }

  const parsedDestination: ParsedUrl = parseUrl(escapedDestination)
  const destQuery = parsedDestination.query
  const destPath = unescapeSegments(`${parsedDestination.pathname!}${parsedDestination.hash || ''}`)
  const destHostname = unescapeSegments(parsedDestination.hostname || '')
  const destPathParamKeys: Key[] = []
  const destHostnameParamKeys: Key[] = []
  pathToRegexp(destPath, destPathParamKeys)
  pathToRegexp(destHostname, destHostnameParamKeys)

  const destParams: (string | number)[] = []

  destPathParamKeys.forEach((key) => destParams.push(key.name))
  destHostnameParamKeys.forEach((key) => destParams.push(key.name))

  const destPathCompiler = compile(
    destPath,
    // we don't validate while compiling the destination since we should
    // have already validated before we got to this point and validating
    // breaks compiling destinations with named pattern params from the source
    // e.g. /something:hello(.*) -> /another/:hello is broken with validation
    // since compile validation is meant for reversing and not for inserting
    // params from a separate path-regex into another
    { validate: false },
  )

  const destHostnameCompiler = compile(destHostname, { validate: false })

  // update any params in query values
  for (const [key, strOrArray] of Object.entries(destQuery)) {
    // the value needs to start with a forward-slash to be compiled
    // correctly
    if (Array.isArray(strOrArray)) {
      destQuery[key] = strOrArray.map((value) =>
        compileNonPath(unescapeSegments(value), args.params),
      )
    } else {
      destQuery[key] = compileNonPath(unescapeSegments(strOrArray), args.params)
    }
  }

  // add path params to query if it's not a redirect and not
  // already defined in destination query or path
  const paramKeys = Object.keys(args.params).filter((name) => name !== 'nextInternalLocale')

  if (args.appendParamsToQuery && !paramKeys.some((key) => destParams.includes(key))) {
    for (const key of paramKeys) {
      if (!(key in destQuery)) {
        destQuery[key] = args.params[key]
      }
    }
  }

  let newUrl

  try {
    newUrl = destPathCompiler(args.params)

    const [pathname, hash] = newUrl.split('#')
    parsedDestination.hostname = destHostnameCompiler(args.params)
    parsedDestination.pathname = pathname
    parsedDestination.hash = `${hash ? '#' : ''}${hash || ''}`
    delete (parsedDestination as any).search
  } catch (err: any) {
    if (err.message.match(/Expected .*? to not repeat, but got an array/)) {
      throw new Error(
        `To use a multi-match in the destination you must add \`*\` at the end of the param name to signify it should repeat. https://nextjs.org/docs/messages/invalid-multi-match`,
      )
    }
    throw err
  }

  // Query merge order lowest priority to highest
  // 1. initial URL query values
  // 2. path segment values
  // 3. destination specified query values
  parsedDestination.query = {
    ...query,
    ...parsedDestination.query,
  }

  return {
    newUrl,
    destQuery,
    parsedDestination,
  }
}

/**
 * Ensure only a-zA-Z are used for param names for proper interpolating
 * with path-to-regexp
 */
function getSafeParamName(paramName: string) {
  let newParamName = ''

  for (let i = 0; i < paramName.length; i++) {
    const charCode = paramName.charCodeAt(i)

    if (
      (charCode > 64 && charCode < 91) || // A-Z
      (charCode > 96 && charCode < 123) // a-z
    ) {
      newParamName += paramName[i]
    }
  }
  return newParamName
}

function escapeSegment(str: string, segmentName: string) {
  return str.replace(
    new RegExp(`:${escapeStringRegexp(segmentName)}`, 'g'),
    `__ESC_COLON_${segmentName}`,
  )
}

function unescapeSegments(str: string) {
  return str.replace(/__ESC_COLON_/gi, ':')
}

/*
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ packages/next/src/shared/lib/router/utils/is-dynamic.ts                 │
  └─────────────────────────────────────────────────────────────────────────┘
 */
// Identify /[param]/ in route string
const TEST_ROUTE = /\/\[[^/]+?\](?=\/|$)/

export function isDynamicRoute(route: string): boolean {
  return TEST_ROUTE.test(route)
}

/*
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ packages/next/shared/lib/router/utils/middleware-route-matcher.ts       │
  └─────────────────────────────────────────────────────────────────────────┘
 */
export interface MiddlewareRouteMatch {
  (
    pathname: string | null | undefined,
    request: Pick<Request, 'headers' | 'url'>,
    query: Params,
  ): boolean
}

export interface MiddlewareMatcher {
  regexp: string
  locale?: false
  has?: RouteHas[]
  missing?: RouteHas[]
}

const decodeMaybeEncodedPath = (path: string): string => {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export function getMiddlewareRouteMatcher(matchers: MiddlewareMatcher[]): MiddlewareRouteMatch {
  return (
    unsafePathname: string | null | undefined,
    req: Pick<Request, 'headers' | 'url'>,
    query: Params,
  ) => {
    const pathname = decodeMaybeEncodedPath(unsafePathname ?? '')

    for (const matcher of matchers) {
      const routeMatch = new RegExp(matcher.regexp).exec(pathname)
      if (!routeMatch) {
        continue
      }

      if (matcher.has || matcher.missing) {
        const hasParams = matchHas(req, query, matcher.has, matcher.missing)
        if (!hasParams) {
          continue
        }
      }

      return true
    }

    return false
  }
}
