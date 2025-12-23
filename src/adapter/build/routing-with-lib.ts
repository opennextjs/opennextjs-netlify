import { cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path/posix'

import { glob } from 'fast-glob'

import { RoutingPreparedConfig } from '../run/routing-with-lib.js'

import {
  DISPLAY_NAME_ROUTING,
  GENERATOR,
  NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS,
  PLUGIN_DIR,
} from './constants.js'
import type { NetlifyAdapterContext, OnBuildCompleteContext } from './types.js'

const ROUTING_FUNCTION_INTERNAL_NAME = 'next_routing'
const ROUTING_FUNCTION_DIR = join(
  NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS,
  ROUTING_FUNCTION_INTERNAL_NAME,
)

type RoutingJsonConfig = Omit<RoutingPreparedConfig, 'invokeMiddleware'>

export function generateNextRoutingJsonConfig(
  nextAdapterContext: OnBuildCompleteContext,
  netlifyAdapterContext: NetlifyAdapterContext,
): RoutingJsonConfig {
  const pathnames = [
    ...netlifyAdapterContext.preparedOutputs.staticAssets,
    ...Object.keys(netlifyAdapterContext.preparedOutputs.staticAssetsAliases),
    ...Object.keys(netlifyAdapterContext.preparedOutputs.endpoints),
  ]

  const hasMiddleware = Boolean(nextAdapterContext.outputs.middleware)
  const hasPages =
    nextAdapterContext.outputs.pages.length !== 0 ||
    nextAdapterContext.outputs.pagesApi.length !== 0

  const shouldNormalizeNextData =
    hasMiddleware &&
    hasPages &&
    !(
      nextAdapterContext.config.skipMiddlewareUrlNormalize ||
      nextAdapterContext.config.skipProxyUrlNormalize
    )

  return {
    buildId: nextAdapterContext.buildId,
    // i18n: nextAdapterContext.config.i18n,
    basePath: nextAdapterContext.config.basePath,
    routes: {
      beforeMiddleware: nextAdapterContext.routes.redirects,
      beforeFiles: nextAdapterContext.routes.rewrites.beforeFiles,
      afterFiles: nextAdapterContext.routes.rewrites.afterFiles,
      dynamicRoutes: nextAdapterContext.routes.dynamicRoutes,
      onMatch: nextAdapterContext.routes.headers,
      fallback: nextAdapterContext.routes.rewrites.fallback,
    },
    shouldNormalizeNextData,
    pathnames,
  }
}

export async function onBuildComplete(
  nextAdapterContext: OnBuildCompleteContext,
  netlifyAdapterContext: NetlifyAdapterContext,
) {
  const routing = await generateNextRoutingJsonConfig(nextAdapterContext, netlifyAdapterContext)

  // for dev/debugging purposes only
  await writeFile('./routes.json', JSON.stringify(routing, null, 2))
  await writeFile(
    './prepared-outputs.json',
    JSON.stringify(netlifyAdapterContext.preparedOutputs, null, 2),
  )

  await copyRuntime(ROUTING_FUNCTION_DIR)

  const entrypoint = /* javascript */ `
    import { runNextRouting } from "./dist/adapter/run/routing-with-lib.js";

    const routingBuildTimeConfig = ${JSON.stringify(routing, null, 2)}
    const preparedOutputs = ${JSON.stringify(netlifyAdapterContext.preparedOutputs, null, 2)}

    const asyncLoadMiddleware = () => ${netlifyAdapterContext.preparedOutputs.middleware ? `import('./next_middleware.js').then(mod => mod.default)` : `Promise.reject(new Error('No middleware output'))`}

    export default async function handler(request, context) {
      return runNextRouting(request, context, routingBuildTimeConfig, preparedOutputs)
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
