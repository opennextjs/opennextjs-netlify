import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, parse, relative } from 'node:path/posix'

import { glob } from 'fast-glob'

import type { RequestData } from '../../../edge-runtime/lib/types.ts'

// import type { IntegrationsConfig } from '@netlify/edge-functions'

// import { pathToRegexp } from 'path-to-regexp'

import {
  // DISPLAY_NAME_MIDDLEWARE,
  // GENERATOR,
  NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS,
  PLUGIN_DIR,
} from './constants.js'
import type { NetlifyAdapterContext, NextConfigComplete, OnBuildCompleteContext } from './types.js'

const MIDDLEWARE_FUNCTION_INTERNAL_NAME = 'next_middleware'

const MIDDLEWARE_FUNCTION_DIR = join(NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS, 'next_routing')

export async function onBuildComplete(
  nextAdapterContext: OnBuildCompleteContext,
  netlifyAdapterContext: NetlifyAdapterContext,
) {
  const { middleware } = nextAdapterContext.outputs
  if (!middleware) {
    return
  }

  if (middleware.runtime === 'edge') {
    await copyHandlerDependenciesForEdgeMiddleware(middleware)
  } else if (middleware.runtime === 'nodejs') {
    await copyHandlerDependenciesForNodeMiddleware(middleware, nextAdapterContext.repoRoot)
  }

  await writeHandlerFile(middleware, nextAdapterContext.config)

  netlifyAdapterContext.preparedOutputs.middleware = true
}

const copyHandlerDependenciesForEdgeMiddleware = async (
  middleware: Required<OnBuildCompleteContext['outputs']>['middleware'],
) => {
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

  for (const [relativePath, absolutePath] of Object.entries(middleware.assets)) {
    if (absolutePath.endsWith('.wasm')) {
      const data = await readFile(absolutePath)

      const { name } = parse(relativePath)
      parts.push(`const ${name} = Uint8Array.from(${JSON.stringify([...data])})`)
    } else if (absolutePath.endsWith('.js')) {
      const entrypoint = await readFile(absolutePath, 'utf8')
      parts.push(`;// Concatenated file: ${relativePath} \n`, entrypoint)
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

const copyHandlerDependenciesForNodeMiddleware = async (
  middleware: Required<OnBuildCompleteContext['outputs']>['middleware'],
  repoRoot: string,
) => {
  const edgeRuntimeDir = join(PLUGIN_DIR, 'edge-runtime')
  const shimPath = join(edgeRuntimeDir, 'shim/node.js')
  const shim = await readFile(shimPath, 'utf8')

  const parts = [shim]

  const files: string[] = Object.values(middleware.assets)
  if (!files.includes(middleware.filePath)) {
    files.push(middleware.filePath)
  }

  // C++ addons are not supported
  const unsupportedDotNodeModules = files.filter((file) => file.endsWith('.node'))
  if (unsupportedDotNodeModules.length !== 0) {
    throw new Error(
      `Usage of unsupported C++ Addon(s) found in Node.js Middleware:\n${unsupportedDotNodeModules.map((file) => `- ${file}`).join('\n')}\n\nCheck https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/#limitations for more information.`,
    )
  }

  parts.push(`const virtualModules = new Map();`)

  const handleFileOrDirectory = async (fileOrDir: string) => {
    const stats = await stat(fileOrDir)
    if (stats.isDirectory()) {
      const filesInDir = await readdir(fileOrDir)
      for (const fileInDir of filesInDir) {
        await handleFileOrDirectory(join(fileOrDir, fileInDir))
      }
    } else {
      // avoid unnecessary files
      if (fileOrDir.endsWith('.d.ts') || fileOrDir.endsWith('.js.map')) {
        return
      }
      const content = await readFile(fileOrDir, 'utf8')

      parts.push(
        `virtualModules.set(${JSON.stringify(relative(repoRoot, fileOrDir))}, ${JSON.stringify(content)});`,
      )
    }
  }

  for (const file of files) {
    await handleFileOrDirectory(file)
  }
  parts.push(`registerCJSModules(import.meta.url, virtualModules);

    const require = createRequire(import.meta.url);
    const handlerMod = require("./${relative(repoRoot, middleware.filePath)}");
    const handler = handlerMod.default || handlerMod;

    export default handler
    `)

  const outputFile = join(MIDDLEWARE_FUNCTION_DIR, `concatenated-file.js`)

  await mkdir(dirname(outputFile), { recursive: true })

  await writeFile(outputFile, parts.join('\n'))
}

const writeHandlerFile = async (
  middleware: Required<OnBuildCompleteContext['outputs']>['middleware'],
  nextConfig: NextConfigComplete,
) => {
  // const handlerRuntimeDirectory = join(MIDDLEWARE_FUNCTION_DIR, 'edge-runtime')

  // Copying the runtime files. These are the compatibility layer between
  // Netlify Edge Functions and the Next.js edge runtime.
  await copyRuntime(MIDDLEWARE_FUNCTION_DIR)

  const nextConfigForMiddleware: RequestData['nextConfig'] = {
    basePath: nextConfig.basePath,
    i18n: nextConfig.i18n,
    trailingSlash: nextConfig.trailingSlash,
    experimental: {
      // Include any experimental config that might affect middleware behavior
      cacheLife: nextConfig.experimental?.cacheLife,
      authInterrupts: nextConfig.experimental?.authInterrupts,
      clientParamParsingOrigins: nextConfig.experimental?.clientParamParsingOrigins,
    },
  }

  // Writing a file with the matchers that should trigger this function. We'll
  // read this file from the function at runtime.
  // await writeFile(
  //   join(handlerRuntimeDirectory, 'matchers.json'),
  //   JSON.stringify(middleware.config.matchers ?? []),
  // )

  // The config is needed by the edge function to match and normalize URLs. To
  // avoid shipping and parsing a large file at runtime, let's strip it down to
  // just the properties that the edge function actually needs.
  // const minimalNextConfig = {
  //   basePath: nextConfig.basePath,
  //   i18n: nextConfig.i18n,
  //   trailingSlash: nextConfig.trailingSlash,
  //   skipMiddlewareUrlNormalize: nextConfig.skipMiddlewareUrlNormalize,
  // }

  // await writeFile(
  //   join(handlerRuntimeDirectory, 'next.config.json'),
  //   JSON.stringify(minimalNextConfig),
  // )

  // const htmlRewriterWasm = await readFile(
  //   join(
  //     PLUGIN_DIR,
  //     'edge-runtime/vendor/deno.land/x/htmlrewriter@v1.0.0/pkg/htmlrewriter_bg.wasm',
  //   ),
  // )

  // const functionConfig = {
  //   cache: undefined,
  //   generator: GENERATOR,
  //   name: DISPLAY_NAME_MIDDLEWARE,
  //   pattern: augmentMatchers(middleware, nextConfig).map((matcher) => matcher.sourceRegex),
  // } satisfies IntegrationsConfig

  // Writing the function entry file. It wraps the middleware code with the
  // compatibility layer mentioned above.
  await writeFile(
    join(MIDDLEWARE_FUNCTION_DIR, `${MIDDLEWARE_FUNCTION_INTERNAL_NAME}.js`),
    /* javascript */ `
    import { handleMiddleware } from './edge-runtime/middleware.ts';
    import handler from './concatenated-file.js';

    const nextConfig = ${JSON.stringify(nextConfigForMiddleware)}

    export default (req) => handleMiddleware(req, handler, nextConfig);
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
// const augmentMatchers = (
//   middleware: Required<OnBuildCompleteContext['outputs']>['middleware'],
//   nextConfig: NextConfigComplete,
// ) => {
//   const i18NConfig = nextConfig.i18n
//   if (!i18NConfig) {
//     return middleware.config.matchers ?? []
//   }
//   return (middleware.config.matchers ?? []).flatMap((matcher) => {
//     if (matcher.originalSource && matcher.locale !== false) {
//       return [
//         matcher.regexp
//           ? {
//               ...matcher,
//               // https://github.com/vercel/next.js/blob/5e236c9909a768dc93856fdfad53d4f4adc2db99/packages/next/src/build/analysis/get-page-static-info.ts#L332-L336
//               // Next is producing pretty broad matcher for i18n locale. Presumably rest of their infrastructure protects this broad matcher
//               // from matching on non-locale paths. For us this becomes request entry point, so we need to narrow it down to just defined locales
//               // otherwise users might get unexpected matches on paths like `/api*`
//               regexp: matcher.regexp.replace(/\[\^\/\.]+/g, `(${i18NConfig.locales.join('|')})`),
//             }
//           : matcher,
//         {
//           ...matcher,
//           regexp: pathToRegexp(matcher.originalSource).source,
//         },
//       ]
//     }
//     return matcher
//   })
// }
