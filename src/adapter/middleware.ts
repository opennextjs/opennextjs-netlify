import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'

import { glob } from 'fast-glob'
import { pathToRegexp } from 'path-to-regexp'

import { GENERATOR, PLUGIN_DIR } from './constants.js'
import type { FrameworksAPIConfig, NextConfigComplete, OnBuildCompleteContext } from './types.js'

const NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS = '.netlify/v1/edge-functions'
const MIDDLEWARE_FUNCTION_NAME = 'middleware'

const MIDDLEWARE_FUNCTION_DIR = join(
  NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS,
  MIDDLEWARE_FUNCTION_NAME,
)

export async function onBuildComplete(
  ctx: OnBuildCompleteContext,
  frameworksAPIConfigArg: FrameworksAPIConfig,
) {
  const frameworksAPIConfig: FrameworksAPIConfig = frameworksAPIConfigArg ?? {}

  const { middleware } = ctx.outputs
  if (!middleware) {
    return frameworksAPIConfig
  }

  if (middleware.runtime !== 'edge') {
    // TODO: nodejs middleware
    return frameworksAPIConfig
  }

  await copyHandlerDependenciesForEdgeMiddleware(middleware)
  await writeHandlerFile(middleware, ctx.config)

  return frameworksAPIConfig
}

const copyHandlerDependenciesForEdgeMiddleware = async (
  middleware: Required<OnBuildCompleteContext['outputs']>['middleware'],
) => {
  // const srcDir = join(ctx.standaloneDir, ctx.nextDistDir)

  const edgeRuntimeDir = join(PLUGIN_DIR, 'edge-runtime')
  const shimPath = join(edgeRuntimeDir, 'shim/edge.js')
  const shim = await readFile(shimPath, 'utf8')

  const parts = [shim]

  const outputFile = join(MIDDLEWARE_FUNCTION_DIR, `concatenated-file.js`)

  // TODO: env is not available in outputs.middleware
  // if (env) {
  //   // Prepare environment variables for draft-mode (i.e. __NEXT_PREVIEW_MODE_ID, __NEXT_PREVIEW_MODE_SIGNING_KEY, __NEXT_PREVIEW_MODE_ENCRYPTION_KEY)
  //   for (const [key, value] of Object.entries(env)) {
  //     parts.push(`process.env.${key} = '${value}';`)
  //   }
  // }

  for (const [relative, absolute] of Object.entries(middleware.assets)) {
    if (absolute.endsWith('.wasm')) {
      const data = await readFile(absolute)

      const { name } = parse(relative)
      parts.push(`const ${name} = Uint8Array.from(${JSON.stringify([...data])})`)
    } else if (absolute.endsWith('.js')) {
      const entrypoint = await readFile(absolute, 'utf8')
      parts.push(`;// Concatenated file: ${relative} \n`, entrypoint)
    }
  }
  parts.push(
    `const middlewareEntryKey = Object.keys(_ENTRIES).find(entryKey => entryKey.startsWith("middleware_${middleware.id}"));`,
    // turbopack entries are promises so we await here to get actual entry
    // non-turbopack entries are already resolved, so await does not change anything
    `export default await _ENTRIES[middlewareEntryKey].default;`,
  )
  await mkdir(dirname(outputFile), { recursive: true })

  await writeFile(outputFile, parts.join('\n'))
}

const writeHandlerFile = async (
  middleware: Required<OnBuildCompleteContext['outputs']>['middleware'],
  nextConfig: NextConfigComplete,
) => {
  const handlerRuntimeDirectory = join(MIDDLEWARE_FUNCTION_DIR, 'edge-runtime')

  // Copying the runtime files. These are the compatibility layer between
  // Netlify Edge Functions and the Next.js edge runtime.
  await copyRuntime(MIDDLEWARE_FUNCTION_DIR)

  // Writing a file with the matchers that should trigger this function. We'll
  // read this file from the function at runtime.
  await writeFile(
    join(handlerRuntimeDirectory, 'matchers.json'),
    JSON.stringify(middleware.config.matchers ?? []),
  )

  // The config is needed by the edge function to match and normalize URLs. To
  // avoid shipping and parsing a large file at runtime, let's strip it down to
  // just the properties that the edge function actually needs.
  const minimalNextConfig = {
    basePath: nextConfig.basePath,
    i18n: nextConfig.i18n,
    trailingSlash: nextConfig.trailingSlash,
    skipMiddlewareUrlNormalize: nextConfig.skipMiddlewareUrlNormalize,
  }

  await writeFile(
    join(handlerRuntimeDirectory, 'next.config.json'),
    JSON.stringify(minimalNextConfig),
  )

  const htmlRewriterWasm = await readFile(
    join(
      PLUGIN_DIR,
      'edge-runtime/vendor/deno.land/x/htmlrewriter@v1.0.0/pkg/htmlrewriter_bg.wasm',
    ),
  )

  // Writing the function entry file. It wraps the middleware code with the
  // compatibility layer mentioned above.
  await writeFile(
    join(MIDDLEWARE_FUNCTION_DIR, `middleware.js`),
    `
    import { init as htmlRewriterInit } from './edge-runtime/vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'
    import { handleMiddleware } from './edge-runtime/middleware.ts';
    import handler from './concatenated-file.js';

    await htmlRewriterInit({ module_or_path: Uint8Array.from(${JSON.stringify([
      ...htmlRewriterWasm,
    ])}) });

    export default (req, context) => handleMiddleware(req, context, handler);

    export const config = ${JSON.stringify({
      cache: undefined,
      generator: GENERATOR,
      name: 'Next.js Middleware Handler',
      pattern: augmentMatchers(middleware, nextConfig).map((matcher) => matcher.regexp),
    })}
    `,
  )
}

const copyRuntime = async (handlerDirectory: string): Promise<void> => {
  const files = await glob('edge-runtime/**/*', {
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

/**
 * When i18n is enabled the matchers assume that paths _always_ include the
 * locale. We manually add an extra matcher for the original path without
 * the locale to ensure that the edge function can handle it.
 * We don't need to do this for data routes because they always have the locale.
 */
const augmentMatchers = (
  middleware: Required<OnBuildCompleteContext['outputs']>['middleware'],
  nextConfig: NextConfigComplete,
) => {
  const i18NConfig = nextConfig.i18n
  if (!i18NConfig) {
    return middleware.config.matchers ?? []
  }
  return (middleware.config.matchers ?? []).flatMap((matcher) => {
    if (matcher.originalSource && matcher.locale !== false) {
      return [
        matcher.regexp
          ? {
              ...matcher,
              // https://github.com/vercel/next.js/blob/5e236c9909a768dc93856fdfad53d4f4adc2db99/packages/next/src/build/analysis/get-page-static-info.ts#L332-L336
              // Next is producing pretty broad matcher for i18n locale. Presumably rest of their infrastructure protects this broad matcher
              // from matching on non-locale paths. For us this becomes request entry point, so we need to narrow it down to just defined locales
              // otherwise users might get unexpected matches on paths like `/api*`
              regexp: matcher.regexp.replace(/\[\^\/\.]+/g, `(${i18NConfig.locales.join('|')})`),
            }
          : matcher,
        {
          ...matcher,
          regexp: pathToRegexp(matcher.originalSource).source,
        },
      ]
    }
    return matcher
  })
}
