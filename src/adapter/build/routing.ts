import { cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path/posix'

import { glob } from 'fast-glob'

import type { RoutingRule, RoutingRuleRedirect, RoutingRuleRewrite } from '../run/routing.js'

import {
  DISPLAY_NAME_ROUTING,
  GENERATOR,
  NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS,
  PLUGIN_DIR,
} from './constants.js'
import type { NetlifyAdapterContext, OnBuildCompleteContext } from './types.js'

function fixDestinationGroupReplacements(destination: string, sourceRegex: string): string {
  // convert $nxtPslug to $<nxtPslug> etc

  // find all capturing groups in sourceRegex
  const segments = [...sourceRegex.matchAll(/\(\?<(?<segment_name>[^>]+)>/g)]

  let adjustedDestination = destination
  for (const segment of segments) {
    if (segment.groups?.segment_name) {
      adjustedDestination = adjustedDestination.replaceAll(
        `$${segment.groups.segment_name}`,
        `$<${segment.groups.segment_name}>`,
      )
    }
  }

  if (adjustedDestination !== destination) {
    console.log('fixing named captured group replacement', {
      sourceRegex,
      segments,
      destination,
      adjustedDestination,
    })
  }

  return adjustedDestination
}

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
      destination: fixDestinationGroupReplacements(redirect.destination, redirect.sourceRegex),
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
      destination: fixDestinationGroupReplacements(
        dynamicRoute.destination,
        dynamicRoute.sourceRegex,
      ),
      rerunRoutingPhases: ['filesystem', 'rewrite'], // this is attempt to mimic Vercel's check: true
    },
  } satisfies RoutingRuleRewrite
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
            destination: `${nextAdapterContext.config.basePath}/_next/data/${await netlifyAdapterContext.getBuildId()}/$1.json`,
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
