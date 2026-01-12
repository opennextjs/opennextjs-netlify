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

  return {
    buildId: nextAdapterContext.buildId,
    // TODO: check i18n type error
    // @ts-expect-error something something about readonly
    i18n: nextAdapterContext.config.i18n ?? undefined,
    basePath: nextAdapterContext.config.basePath,
    routes: nextAdapterContext.routing,
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

    const middlewareConfig = ${
      netlifyAdapterContext.preparedOutputs.middleware
        ? `{ enabled: true, load: () => import('./next_middleware.js').then(mod => mod.default), matchers: [${(nextAdapterContext.outputs.middleware?.config.matchers ?? []).map((matcher) => `new RegExp(${JSON.stringify(matcher.sourceRegex)})`).join(', ')}] }`
        : `{ enabled: false }`
    }
    
    export default async function handler(request, context) {
      return runNextRouting(request, context, routingBuildTimeConfig, preparedOutputs, middlewareConfig)
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
