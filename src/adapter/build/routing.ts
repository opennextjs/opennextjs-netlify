import { cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path/posix'
import { format as formatUrl, parse as parseUrl } from 'node:url'

import { glob } from 'fast-glob'
import {
  pathToRegexp,
  compile as pathToRegexpCompile,
  type Key as PathToRegexpKey,
} from 'path-to-regexp'

import type { RoutingRule, RoutingRuleRedirect, RoutingRuleRewrite } from '../run/routing.js'

import {
  DISPLAY_NAME_ROUTING,
  GENERATOR,
  NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS,
  PLUGIN_DIR,
} from './constants.js'
import type { NetlifyAdapterContext, OnBuildCompleteContext } from './types.js'

const UN_NAMED_SEGMENT = '__UN_NAMED_SEGMENT__'

// https://github.com/vercel/vercel/blob/8beae7035bf0d3e5cfc1df337b83fbbe530c4d9b/packages/routing-utils/src/superstatic.ts#L273
export function sourceToRegex(source: string) {
  const keys: PathToRegexpKey[] = []
  const regexp = pathToRegexp(source, keys, {
    strict: true,
    sensitive: true,
    delimiter: '/',
  })

  return {
    sourceRegexString: regexp.source,
    segments: keys
      .map((key) => key.name)
      .map((keyName) => {
        if (typeof keyName !== 'string') {
          return UN_NAMED_SEGMENT
        }
        return keyName
      }),
  }
}

// https://github.com/vercel/vercel/blob/8beae7035bf0d3e5cfc1df337b83fbbe530c4d9b/packages/routing-utils/src/superstatic.ts#L345
const escapeSegment = (str: string, segmentName: string) =>
  str.replace(new RegExp(`:${segmentName}`, 'g'), `__esc_colon_${segmentName}`)

// https://github.com/vercel/vercel/blob/8beae7035bf0d3e5cfc1df337b83fbbe530c4d9b/packages/routing-utils/src/superstatic.ts#L348
const unescapeSegments = (str: string) => str.replace(/__esc_colon_/gi, ':')

// https://github.com/vercel/vercel/blob/8beae7035bf0d3e5cfc1df337b83fbbe530c4d9b/packages/routing-utils/src/superstatic.ts#L464
function safelyCompile(
  val: string,
  indexes: { [k: string]: string },
  attemptDirectCompile?: boolean,
): string {
  let value = val
  if (!value) {
    return value
  }

  if (attemptDirectCompile) {
    try {
      // Attempt compiling normally with path-to-regexp first and fall back
      // to safely compiling to handle edge cases if path-to-regexp compile
      // fails
      return pathToRegexpCompile(value, { validate: false })(indexes)
    } catch {
      // non-fatal, we continue to safely compile
    }
  }

  for (const key of Object.keys(indexes)) {
    if (value.includes(`:${key}`)) {
      value = value
        .replace(new RegExp(`:${key}\\*`, 'g'), `:${key}--ESCAPED_PARAM_ASTERISK`)
        .replace(new RegExp(`:${key}\\?`, 'g'), `:${key}--ESCAPED_PARAM_QUESTION`)
        .replace(new RegExp(`:${key}\\+`, 'g'), `:${key}--ESCAPED_PARAM_PLUS`)
        .replace(new RegExp(`:${key}(?!\\w)`, 'g'), `--ESCAPED_PARAM_COLON${key}`)
    }
  }
  value = value
    // eslint-disable-next-line unicorn/better-regex
    .replace(/(:|\*|\?|\+|\(|\)|\{|\})/g, '\\$1')
    .replace(/--ESCAPED_PARAM_PLUS/g, '+')
    .replace(/--ESCAPED_PARAM_COLON/g, ':')
    .replace(/--ESCAPED_PARAM_QUESTION/g, '?')
    .replace(/--ESCAPED_PARAM_ASTERISK/g, '*')

  // the value needs to start with a forward-slash to be compiled
  // correctly
  return pathToRegexpCompile(`/${value}`, { validate: false })(indexes).slice(1)
}

// https://github.com/vercel/vercel/blob/8beae7035bf0d3e5cfc1df337b83fbbe530c4d9b/packages/routing-utils/src/superstatic.ts#L350
export function destinationToReplacementString(destination: string, segments: string[]) {
  // convert /path/:id/route to /path/$1/route
  // convert /path/:id+ to /path/$1

  let escapedDestination = destination

  const indexes: { [k: string]: string } = {}

  segments.forEach((name, index) => {
    indexes[name] = `$${index + 1}`
    escapedDestination = escapeSegment(escapedDestination, name)
  })

  const parsedDestination = parseUrl(escapedDestination, true)
  delete (parsedDestination as any).href
  delete (parsedDestination as any).path
  delete (parsedDestination as any).search
  delete (parsedDestination as any).host
  let { pathname, ...rest } = parsedDestination
  pathname = unescapeSegments(pathname || '')

  const pathnameKeys: PathToRegexpKey[] = []

  try {
    pathToRegexp(pathname, pathnameKeys)
  } catch {
    // this is not fatal so don't error when failing to parse the
    // params from the destination
  }

  pathname = safelyCompile(pathname, indexes, true)

  const finalDestination = formatUrl({
    ...rest,
    // hostname,
    pathname,
    // query,
    // hash,
  })
  // url.format() escapes the dollar sign but it must be preserved for now-proxy
  return finalDestination.replace(/%24/g, '$')
}

export function convertRedirectToRoutingRule(
  redirect: Pick<
    OnBuildCompleteContext['routes']['redirects'][number],
    'source' | 'destination' | 'priority'
  >,
  description?: string,
): RoutingRuleRedirect {
  const { sourceRegexString, segments } = sourceToRegex(redirect.source)

  const convertedDestination = destinationToReplacementString(redirect.destination, segments)

  return {
    description,
    match: {
      path: sourceRegexString,
    },
    apply: {
      type: 'redirect',
      destination: convertedDestination,
    },
  } satisfies RoutingRuleRedirect
}

export async function generateRoutingRules(
  nextAdapterContext: OnBuildCompleteContext,
  netlifyAdapterContext: NetlifyAdapterContext,
) {
  const hasMiddleware = Boolean(nextAdapterContext.outputs.middleware)
  const hasPages = nextAdapterContext.outputs.pages.length !== 0
  const shouldDenormalizeJsonDataForMiddleware =
    hasMiddleware && hasPages && nextAdapterContext.config.skipMiddlewareUrlNormalize

  // group redirects by priority, as it impact ordering of routing rules
  const priorityRedirects: RoutingRuleRedirect[] = []
  const redirects: RoutingRuleRedirect[] = []
  for (const redirect of nextAdapterContext.routes.redirects) {
    if (redirect.priority) {
      priorityRedirects.push(
        convertRedirectToRoutingRule(
          redirect,
          `Priority redirect from ${redirect.source} to ${redirect.destination}`,
        ),
      )
    } else {
      redirects.push(
        convertRedirectToRoutingRule(
          redirect,
          `Redirect from ${redirect.source} to ${redirect.destination}`,
        ),
      )
    }
  }

  const normalizeNextData: RoutingRuleRewrite[] = [
    {
      description: 'Normalize _next/data',
      match: {
        path: `^${nextAdapterContext.config.basePath}/_next/data/${await netlifyAdapterContext.getBuildId()}/(.*)\\.json`,
        has: [
          {
            type: 'header',
            key: 'x-nextjs-data',
          },
        ],
      },
      apply: {
        type: 'rewrite',
        destination: `${nextAdapterContext.config.basePath}/$1${nextAdapterContext.config.trailingSlash ? '/' : ''}`,
      },
    },
    {
      description: 'Fix _next/data index normalization',
      match: {
        path: `^${nextAdapterContext.config.basePath}/index(?:/)?`,
        has: [
          {
            type: 'header',
            key: 'x-nextjs-data',
          },
        ],
      },
      apply: {
        type: 'rewrite',
        destination: `${nextAdapterContext.config.basePath}/`,
      },
    },
  ]

  const denormalizeNextData: RoutingRuleRewrite[] = [
    {
      description: 'Fix _next/data index denormalization',
      match: {
        path: `^${nextAdapterContext.config.basePath}/$`,
        has: [
          {
            type: 'header',
            key: 'x-nextjs-data',
          },
        ],
      },
      apply: {
        type: 'rewrite',
        destination: `${nextAdapterContext.config.basePath}/index`,
      },
    },
    {
      description: 'Denormalize _next/data',
      match: {
        path: `^${nextAdapterContext.config.basePath}/((?!_next/)(?:.*[^/]|.*))/?$`,
        has: [
          {
            type: 'header',
            key: 'x-nextjs-data',
          },
        ],
      },
      apply: {
        type: 'rewrite',
        destination: `${nextAdapterContext.config.basePath}/_next/data/${await netlifyAdapterContext.getBuildId()}/$1.json`,
      },
    },
  ]

  const routing: RoutingRule[] = [
    // order inherited from
    // - () https://github.com/nextjs/adapter-vercel/blob/5ffd14bcb6ac780d2179d9a76e9e83747915bef3/packages/adapter/src/index.ts#L169
    // - https://github.com/vercel/vercel/blob/f0a9aaeef1390acbe25fb755aff0a0d4b04e4f13/packages/next/src/server-build.ts#L1971

    // Desired routes order
    // - Runtime headers
    // - User headers and redirects
    // - Runtime redirects
    // - Runtime routes
    // - Check filesystem, if nothing found continue
    // - User rewrites
    // - Builder rewrites

    // priority redirects includes trailing slash redirect
    ...priorityRedirects, // originally: ...convertedPriorityRedirects,

    ...(hasPages ? normalizeNextData : []), // originally: // normalize _next/data if middleware + pages

    // i18n prefixing routes

    // ...convertedHeaders,

    ...redirects, // originally: ...convertedRedirects,

    // server actions name meta routes

    ...(shouldDenormalizeJsonDataForMiddleware ? denormalizeNextData : []), // originally: // if skip middleware url normalize we denormalize _next/data if middleware + pages

    ...(hasMiddleware
      ? [
          {
            // originally: middleware route
            description: 'Middleware',
            match: { type: 'middleware' },
          } as const,
        ]
      : []),

    ...(shouldDenormalizeJsonDataForMiddleware ? normalizeNextData : []), // originally: // if skip middleware url normalize we normalize _next/data if middleware + pages

    // ...convertedRewrites.beforeFiles,

    // add 404 handling if /404 or locale variants are requested literally

    // add 500 handling if /500 or locale variants are requested literally

    ...(hasPages ? denormalizeNextData : []), // originally: // denormalize _next/data if middleware + pages

    // segment prefetch request rewriting

    // non-segment prefetch rsc request rewriting

    // full rsc request rewriting

    {
      // originally: { handle: 'filesystem' },
      description: 'Static assets or Functions',
      match: { type: 'static-asset-or-function' },
    },

    // TODO(pieh): do we need this given our next/image url loader/generator?
    // ensure the basePath prefixed _next/image is rewritten to the root
    // _next/image path
    // ...(config.basePath
    //   ? [
    //       {
    //         src: path.posix.join('/', config.basePath, '_next/image/?'),
    //         dest: '/_next/image',
    //         check: true,
    //       },
    //     ]
    //   : []),

    ...(hasPages ? normalizeNextData : []), // originally: // normalize _next/data if middleware + pages

    // normalize /index.rsc to just /

    // ...convertedRewrites.afterFiles,

    // ensure bad rewrites with /.rsc are fixed

    {
      // originally: { handle: 'resource' },
      description: 'Image CDN',
      match: { type: 'image-cdn' },
    },

    // ...convertedRewrites.fallback,

    // make sure 404 page is used when a directory is matched without
    // an index page
    // { src: path.posix.join('/', config.basePath, '.*'), status: 404 },

    // { handle: 'miss' },

    // 404 to plain text file for _next/static

    // if i18n is enabled attempt removing locale prefix to check public files

    // rewrite segment prefetch to prefetch/rsc

    // { handle: 'rewrite' },

    // denormalize _next/data if middleware + pages

    // apply _next/data routes (including static ones if middleware + pages)

    // apply 404 if _next/data request since above should have matched
    // and we don't want to match a catch-all dynamic route

    // apply normal dynamic routes
    // ...convertedDynamicRoutes,

    // apply x-nextjs-matched-path header and __next_data_catchall rewrite
    // if middleware + pages

    // { handle: 'hit' },

    // Before we handle static files we need to set proper caching headers
    // {
    //   // This ensures we only match known emitted-by-Next.js files and not
    //   // user-emitted files which may be missing a hash in their filename.
    //   src: path.posix.join(
    //     '/',
    //     config.basePath,
    //     `_next/static/(?:[^/]+/pages|pages|chunks|runtime|css|image|media)/.+`,
    //   ),
    //   // Next.js assets contain a hash or entropy in their filenames, so they
    //   // are guaranteed to be unique and cacheable indefinitely.
    //   headers: {
    //     'cache-control': `public,max-age=${MAX_AGE_ONE_YEAR},immutable`,
    //   },
    //   continue: true,
    //   important: true,
    // },
    // {
    //   src: path.posix.join('/', config.basePath, '/index(?:/)?'),
    //   headers: {
    //     'x-matched-path': '/',
    //   },
    //   continue: true,
    //   important: true,
    // },
    // {
    //   src: path.posix.join('/', config.basePath, `/((?!index$).*?)(?:/)?`),
    //   headers: {
    //     'x-matched-path': '/$1',
    //   },
    //   continue: true,
    //   important: true,
    // },

    // { handle: 'error' },

    // apply 404 output mapping

    // apply 500 output mapping
  ]

  return routing
}

const ROUTING_FUNCTION_INTERNAL_NAME = 'next_routing'
const ROUTING_FUNCTION_DIR = join(
  NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS,
  ROUTING_FUNCTION_INTERNAL_NAME,
)

export async function onBuildComplete(
  nextAdapterContext: OnBuildCompleteContext,
  netlifyAdapterContext: NetlifyAdapterContext,
) {
  const routing = await generateRoutingRules(nextAdapterContext, netlifyAdapterContext)

  // for dev/debugging purposes only
  await writeFile('./routes.json', JSON.stringify(routing, null, 2))
  await writeFile(
    './prepared-outputs.json',
    JSON.stringify(netlifyAdapterContext.preparedOutputs, null, 2),
  )

  await copyRuntime(ROUTING_FUNCTION_DIR)

  // TODO(pieh): middleware case would need to be split in 2 functions

  const entrypoint = /* javascript */ `
    import { runNextRouting } from "./dist/adapter/run/routing.js";

    const routingRules = ${JSON.stringify(routing, null, 2)}
    const outputs = ${JSON.stringify(netlifyAdapterContext.preparedOutputs, null, 2)}

    export default async function handler(request, context) {
      return runNextRouting(request, context, routingRules, outputs)
    }

    export const config = ${JSON.stringify({
      cache: undefined,
      generator: GENERATOR,
      name: DISPLAY_NAME_ROUTING,
      pattern: '.*',
    })}
  `

  await writeFile(join(ROUTING_FUNCTION_DIR, `${ROUTING_FUNCTION_INTERNAL_NAME}.js`), entrypoint)
}

const copyRuntime = async (handlerDirectory: string): Promise<void> => {
  const files = await glob('dist/**/*', {
    cwd: PLUGIN_DIR,
    ignore: ['**/*.test.ts'],
    dot: true,
  })
  await Promise.all(
    files.map((path) =>
      cp(join(PLUGIN_DIR, path), join(handlerDirectory, path), { recursive: true }),
    ),
  )
}
