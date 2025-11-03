import { cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path/posix'

import { glob } from 'fast-glob'

import type {
  RoutingRule,
  RoutingRuleApply,
  RoutingRuleRedirect,
  RoutingRuleRewrite,
} from '../run/routing.js'

import {
  DISPLAY_NAME_ROUTING,
  GENERATOR,
  NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS,
  PLUGIN_DIR,
} from './constants.js'
import type { NetlifyAdapterContext, OnBuildCompleteContext } from './types.js'

export function convertRedirectToRoutingRule(
  redirect: Pick<
    OnBuildCompleteContext['routes']['redirects'][number],
    'sourceRegex' | 'destination' | 'priority'
  >,
  description: string,
): RoutingRuleRedirect {
  return {
    description,
    match: {
      path: redirect.sourceRegex,
    },
    apply: {
      type: 'redirect',
      destination: redirect.destination,
    },
  } satisfies RoutingRuleRedirect
}

export function convertDynamicRouteToRoutingRule(
  dynamicRoute: Pick<
    OnBuildCompleteContext['routes']['dynamicRoutes'][number],
    'sourceRegex' | 'destination'
  >,
  description: string,
): RoutingRuleRewrite {
  return {
    description,
    match: {
      path: dynamicRoute.sourceRegex,
    },
    apply: {
      type: 'rewrite',
      destination: dynamicRoute.destination,
      rerunRoutingPhases: ['filesystem', 'rewrite'], // this is attempt to mimic Vercel's check: true
    },
  } satisfies RoutingRuleRewrite
}

const matchOperatorsRegex = /[|\\{}()[\]^$+*?.-]/g

export function escapeStringRegexp(str: string): string {
  return str.replace(matchOperatorsRegex, '\\$&')
}

export async function generateRoutingRules(
  nextAdapterContext: OnBuildCompleteContext,
  netlifyAdapterContext: NetlifyAdapterContext,
) {
  const escapedBuildId = escapeStringRegexp(nextAdapterContext.buildId)

  const hasMiddleware = Boolean(nextAdapterContext.outputs.middleware)
  const hasPages =
    nextAdapterContext.outputs.pages.length !== 0 ||
    nextAdapterContext.outputs.pagesApi.length !== 0
  const hasApp =
    nextAdapterContext.outputs.appPages.length !== 0 ||
    nextAdapterContext.outputs.appRoutes.length !== 0
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

  const dynamicRoutes: RoutingRuleRewrite[] = []

  for (const dynamicRoute of nextAdapterContext.routes.dynamicRoutes) {
    const isNextData = dynamicRoute.sourceRegex.includes('_next/data')

    if (hasPages && !hasMiddleware) {
      // this was copied from Vercel adapter, not fully sure what it does - especially with the condition
      // not applying equavalent right now, but leaving it commented out
      // if (!route.sourceRegex.includes('_next/data') && !addedNextData404Route) {
      //   addedNextData404Route = true
      //   dynamicRoutes.push({
      //     src: path.posix.join('/', config.basePath || '', '_next/data/(.*)'),
      //     dest: path.posix.join('/', config.basePath || '', '404'),
      //     status: 404,
      //     check: true,
      //   })
      // }
    }
    dynamicRoutes.push(
      convertDynamicRouteToRoutingRule(
        dynamicRoute,
        isNextData
          ? `Mapping dynamic route _next/data to entrypoint: ${dynamicRoute.destination}`
          : `Mapping dynamic route to entrypoint: ${dynamicRoute.destination}`,
      ),
    )
  }

  const normalizeNextData: RoutingRuleRewrite[] = shouldDenormalizeJsonDataForMiddleware
    ? [
        {
          description: 'Normalize _next/data',
          match: {
            path: `^${nextAdapterContext.config.basePath}/_next/data/${escapedBuildId}/(.*)\\.json`,
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
    : []

  const denormalizeNextData: RoutingRuleRewrite[] = shouldDenormalizeJsonDataForMiddleware
    ? [
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
            destination: `${nextAdapterContext.config.basePath}/_next/data/${nextAdapterContext.buildId}/$1.json`,
          },
        },
      ]
    : []

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

    {
      // this is no-op on its own, it's just marker to be able to run subset of routing rules
      description: "'entry' routing phase marker",
      routingPhase: 'entry',
    },

    // priority redirects includes trailing slash redirect
    ...priorityRedirects, // originally: ...convertedPriorityRedirects,

    ...normalizeNextData, // originally: // normalize _next/data if middleware + pages

    // i18n prefixing routes
    ...(nextAdapterContext.config.i18n
      ? [
          // i18n domain handling - not implementing for now
          // Handle auto-adding current default locale to path based on $wildcard
          // This is split into two rules to avoid matching the `/index` route as it causes issues with trailing slash redirect
          // {
          //   description: 'stuff1',
          //   match: {
          //     path: `^${join(
          //       '/',
          //       nextAdapterContext.config.basePath,
          //       '/',
          //     )}(?!(?:_next/.*|${nextAdapterContext.config.i18n.locales
          //       .map((locale) => escapeStringRegexp(locale))
          //       .join('|')})(?:/.*|$))$`,
          //   },
          //   apply: {
          //     type: 'rewrite',
          //     // we aren't able to ensure trailing slash mode here
          //     // so ensure this comes after the trailing slash redirect
          //     destination: `${
          //       nextAdapterContext.config.basePath && nextAdapterContext.config.basePath !== '/'
          //         ? join('/', nextAdapterContext.config.basePath)
          //         : ''
          //     }$wildcard${nextAdapterContext.config.trailingSlash ? '/' : ''}`,
          //   },
          // } satisfies RoutingRuleRewrite,

          // Handle redirecting to locale paths based on NEXT_LOCALE cookie or Accept-Language header
          // eslint-disable-next-line no-negated-condition
          ...(nextAdapterContext.config.i18n.localeDetection !== false
            ? [
                // TODO: implement locale detection
                // {
                //   description: 'Detect locale on root path, redirect and set cookie',
                //   match: {
                //     path: '/',
                //   },
                //   apply: {
                //     type: 'apply',
                //   },
                // } satisfies RoutingRuleApply,
              ]
            : []),

          {
            description: 'Prefix default locale to index',
            match: {
              path: `^${join('/', nextAdapterContext.config.basePath)}$`,
            },
            apply: {
              type: 'rewrite',
              destination: join(
                '/',
                nextAdapterContext.config.basePath,
                nextAdapterContext.config.i18n.defaultLocale,
              ),
            },
          } satisfies RoutingRuleRewrite,
          {
            description: 'Auto-prefix non-locale path with default locale',
            match: {
              path: `^${join(
                '/',
                nextAdapterContext.config.basePath,
                '/',
              )}(?!(?:_next/.*|${nextAdapterContext.config.i18n.locales
                .map((locale) => escapeStringRegexp(locale))
                .join('|')})(?:/.*|$))(.*)$`,
            },
            apply: {
              type: 'rewrite',
              destination: join(
                '/',
                nextAdapterContext.config.basePath,
                nextAdapterContext.config.i18n.defaultLocale,
                '$1',
              ),
            },
          } satisfies RoutingRuleRewrite,
        ]
      : []),

    // ...convertedHeaders,

    ...redirects, // originally: ...convertedRedirects,

    // server actions name meta routes

    ...denormalizeNextData, // originally: // if skip middleware url normalize we denormalize _next/data if middleware + pages

    ...(hasMiddleware
      ? [
          {
            // originally: middleware route
            description: 'Middleware',
            match: { type: 'middleware' },
          } as const,
        ]
      : []),

    ...normalizeNextData, // originally: // if skip middleware url normalize we normalize _next/data if middleware + pages

    // ...convertedRewrites.beforeFiles,

    // add 404 handling if /404 or locale variants are requested literally

    // add 500 handling if /500 or locale variants are requested literally

    ...denormalizeNextData, // originally: // denormalize _next/data if middleware + pages

    // segment prefetch request rewriting

    // non-segment prefetch rsc request rewriting

    // full rsc request rewriting
    ...(hasApp
      ? [
          {
            description: 'Normalize RSC requests (index)',
            match: {
              path: `^${join('/', nextAdapterContext.config.basePath, '/?$')}`,
              has: [
                {
                  type: 'header',
                  key: 'rsc',
                  value: '1',
                },
              ],
            },
            apply: {
              type: 'rewrite',
              destination: `${join('/', nextAdapterContext.config.basePath, '/index.rsc')}`,
              headers: {
                vary: 'RSC, Next-Router-State-Tree, Next-Router-Prefetch',
              },
            },
          } satisfies RoutingRuleRewrite,
          {
            description: 'Normalize RSC requests',
            match: {
              path: `^${join('/', nextAdapterContext.config.basePath, '/((?!.+\\.rsc).+?)(?:/)?$')}`,
              has: [
                {
                  type: 'header',
                  key: 'rsc',
                  value: '1',
                },
              ],
            },
            apply: {
              type: 'rewrite',
              destination: `${join('/', nextAdapterContext.config.basePath, '/$1.rsc')}`,
              headers: {
                vary: 'RSC, Next-Router-State-Tree, Next-Router-Prefetch',
              },
            },
          } satisfies RoutingRuleRewrite,
        ]
      : []),

    {
      // originally: { handle: 'filesystem' },
      // this is no-op on its own, it's just marker to be able to run subset of routing rules
      description: "'filesystem' routing phase marker",
      routingPhase: 'filesystem',
    },

    {
      // originally: { handle: 'filesystem' },
      // this is to actual match on things 'filesystem' should match on
      description: 'Static assets or Functions (no dynamic paths for functions)',
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

    ...normalizeNextData, // originally: // normalize _next/data if middleware + pages

    ...(hasApp
      ? [
          {
            // originally: normalize /index.rsc to just /
            description: 'Normalize index.rsc to just /',
            match: {
              path: join('/', nextAdapterContext.config.basePath, '/index(\\.action|\\.rsc)'),
            },
            apply: {
              type: 'rewrite',
              destination: join('/', nextAdapterContext.config.basePath),
            },
          } satisfies RoutingRuleRewrite,
        ]
      : []),

    // ...convertedRewrites.afterFiles,

    ...(hasApp
      ? [
          // originally: // ensure bad rewrites with /.rsc are fixed
          {
            description: 'Ensure index /.rsc is mapped to /index.rsc',
            match: {
              path: join('/', nextAdapterContext.config.basePath, '/\\.rsc$'),
            },
            apply: {
              type: 'rewrite',
              destination: join('/', nextAdapterContext.config.basePath, `/index.rsc`),
            },
          } satisfies RoutingRuleRewrite,
          {
            description: 'Ensure index <anything>/.rsc is mapped to <anything>.rsc',
            match: {
              path: join('/', nextAdapterContext.config.basePath, '(.+)/\\.rsc$'),
            },
            apply: {
              type: 'rewrite',
              destination: join('/', nextAdapterContext.config.basePath, `$1.rsc`),
            },
          } satisfies RoutingRuleRewrite,
        ]
      : []),

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

    {
      // originally: { handle: 'rewrite' },
      // this is no-op on its own, it's just marker to be able to run subset of routing rules
      description: "'rewrite' routing phase marker",
      routingPhase: 'rewrite',
    },

    // denormalize _next/data if middleware + pages

    // apply _next/data routes (including static ones if middleware + pages)

    // apply 404 if _next/data request since above should have matched
    // and we don't want to match a catch-all dynamic route

    // apply normal dynamic routes
    ...dynamicRoutes, // originally: ...convertedDynamicRoutes,

    ...(hasMiddleware && hasPages
      ? [
          // apply x-nextjs-matched-path header
          // if middleware + pages
          {
            description: 'Apply x-nextjs-matched-path header if middleware + pages',
            match: {
              path: `^${join(
                '/',
                nextAdapterContext.config.basePath,
                '/_next/data/',
                escapedBuildId,
                '/(.*).json',
              )}`,
            },
            apply: {
              type: 'apply',
              headers: {
                'x-nextjs-matched-path': '/$1',
              },
            },
            continue: true,
          } satisfies RoutingRuleApply,
          {
            // apply __next_data_catchall rewrite
            // if middleware + pages
            description: 'Apply __next_data_catchall rewrite if middleware + pages',
            match: {
              path: `^${join(
                '/',
                nextAdapterContext.config.basePath,
                '/_next/data/',
                escapedBuildId,
                '/(.*).json',
              )}`,
            },
            apply: {
              type: 'rewrite',
              destination: '__next_data_catchall',
              statusCode: 200,
            },
          } satisfies RoutingRule,
        ]
      : []),

    {
      // originally: handle: 'hit' },
      // this is no-op on its own, it's just marker to be able to run subset of routing rules
      description: "'hit' routing phase marker",
      routingPhase: 'hit',
      continue: true,
    },

    // Before we handle static files we need to set proper caching headers
    {
      // This ensures we only match known emitted-by-Next.js files and not
      // user-emitted files which may be missing a hash in their filename.
      description: 'Ensure static files caching headers',
      match: {
        path: join(
          '/',
          nextAdapterContext.config.basePath || '',
          `_next/static/(?:[^/]+/pages|pages|chunks|runtime|css|image|media|${nextAdapterContext.buildId})/.+`,
        ),
      },
      apply: {
        type: 'apply',
        // Next.js assets contain a hash or entropy in their filenames, so they
        // are guaranteed to be unique and cacheable indefinitely.
        headers: {
          'cache-control': 'public,max-age=31536000,immutable',
        },
      },
      continue: true,
    },
    {
      description: 'Apply x-matched-path header if index',
      match: {
        path: join('^/', nextAdapterContext.config.basePath, '/index(?:/)?$'),
      },
      apply: {
        type: 'apply',
        headers: {
          'x-matched-path': '/',
        },
      },
      continue: true,
    },
    {
      description: 'Apply x-matched-path header if not index',
      match: {
        path: join('^/', nextAdapterContext.config.basePath, '/((?!index$).*?)(?:/)?$'),
      },
      apply: {
        type: 'apply',
        headers: {
          'x-matched-path': '/$1',
        },
      },
      continue: true,
    },

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
