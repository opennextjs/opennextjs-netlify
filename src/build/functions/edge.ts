import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Manifest, ManifestFunction } from '@netlify/edge-functions'
import { glob } from 'fast-glob'
import type { EdgeFunctionDefinition as NextDefinition } from 'next/dist/build/webpack/plugins/middleware-plugin.js'
import { pathToRegexp } from 'path-to-regexp'

import { EDGE_HANDLER_NAME, PluginContext } from '../plugin-context.js'

const writeEdgeManifest = async (ctx: PluginContext, manifest: Manifest) => {
  await mkdir(ctx.edgeFunctionsDir, { recursive: true })
  await writeFile(join(ctx.edgeFunctionsDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

const copyRuntime = async (ctx: PluginContext, handlerDirectory: string): Promise<void> => {
  const files = await glob('edge-runtime/**/*', {
    cwd: ctx.pluginDir,
    ignore: ['**/*.test.ts'],
    dot: true,
  })
  await Promise.all(
    files.map((path) =>
      cp(join(ctx.pluginDir, path), join(handlerDirectory, path), { recursive: true }),
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
  matchers: NextDefinition['matchers'],
  ctx: PluginContext,
): NextDefinition['matchers'] => {
  const i18NConfig = ctx.buildConfig.i18n
  if (!i18NConfig) {
    return matchers
  }
  return matchers.flatMap((matcher) => {
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

const writeHandlerFile = async (ctx: PluginContext, { matchers, name }: NextDefinition) => {
  const nextConfig = ctx.buildConfig
  const handlerName = getHandlerName({ name })
  const handlerDirectory = join(ctx.edgeFunctionsDir, handlerName)
  const handlerRuntimeDirectory = join(handlerDirectory, 'edge-runtime')

  // Copying the runtime files. These are the compatibility layer between
  // Netlify Edge Functions and the Next.js edge runtime.
  await copyRuntime(ctx, handlerDirectory)

  // Writing a file with the matchers that should trigger this function. We'll
  // read this file from the function at runtime.
  await writeFile(join(handlerRuntimeDirectory, 'matchers.json'), JSON.stringify(matchers))

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
      ctx.pluginDir,
      'edge-runtime/vendor/deno.land/x/htmlrewriter@v1.0.0/pkg/htmlrewriter_bg.wasm',
    ),
  )

  // Writing the function entry file. It wraps the middleware code with the
  // compatibility layer mentioned above.
  await writeFile(
    join(handlerDirectory, `${handlerName}.js`),
    `
    import { init as htmlRewriterInit } from './edge-runtime/vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'
    import { handleMiddleware } from './edge-runtime/middleware.ts';
    import handler from './server/${name}.js';

    await htmlRewriterInit({ module_or_path: Uint8Array.from(${JSON.stringify([
      ...htmlRewriterWasm,
    ])}) });

    export default (req, context) => handleMiddleware(req, context, handler);
    `,
  )
}

const copyHandlerDependencies = async (
  ctx: PluginContext,
  { name, env, files, wasm }: NextDefinition,
) => {
  const srcDir = join(ctx.standaloneDir, ctx.nextDistDir)
  const destDir = join(ctx.edgeFunctionsDir, getHandlerName({ name }))

  const edgeRuntimeDir = join(ctx.pluginDir, 'edge-runtime')
  const shimPath = join(edgeRuntimeDir, 'shim/index.js')
  const shim = await readFile(shimPath, 'utf8')

  const parts = [shim]

  const outputFile = join(destDir, `server/${name}.js`)

  if (env) {
    // Prepare environment variables for draft-mode (i.e. __NEXT_PREVIEW_MODE_ID, __NEXT_PREVIEW_MODE_SIGNING_KEY, __NEXT_PREVIEW_MODE_ENCRYPTION_KEY)
    for (const [key, value] of Object.entries(env)) {
      parts.push(`process.env.${key} = '${value}';`)
    }
  }

  if (wasm?.length) {
    for (const wasmChunk of wasm ?? []) {
      const data = await readFile(join(srcDir, wasmChunk.filePath))
      parts.push(`const ${wasmChunk.name} = Uint8Array.from(${JSON.stringify([...data])})`)
    }
  }

  for (const file of files) {
    const entrypoint = await readFile(join(srcDir, file), 'utf8')
    parts.push(`;// Concatenated file: ${file} \n`, entrypoint)
  }
  parts.push(
    `const middlewareEntryKey = Object.keys(_ENTRIES).find(entryKey => entryKey.startsWith("middleware_${name}"));`,
    // turbopack entries are promises so we await here to get actual entry
    // non-turbopack entries are already resolved, so await does not change anything
    `export default await _ENTRIES[middlewareEntryKey].default;`,
  )
  await mkdir(dirname(outputFile), { recursive: true })

  await writeFile(outputFile, parts.join('\n'))
}

const createEdgeHandler = async (ctx: PluginContext, definition: NextDefinition): Promise<void> => {
  await copyHandlerDependencies(ctx, definition)
  await writeHandlerFile(ctx, definition)
}

const getHandlerName = ({ name }: Pick<NextDefinition, 'name'>): string =>
  `${EDGE_HANDLER_NAME}-${name.replace(/\W/g, '-')}`

const buildHandlerDefinition = (
  ctx: PluginContext,
  { name, matchers, page }: NextDefinition,
): Array<ManifestFunction> => {
  const functionHandlerName = getHandlerName({ name })
  const functionName = name.endsWith('middleware')
    ? 'Next.js Middleware Handler'
    : `Next.js Edge Handler: ${page}`
  const cache = name.endsWith('middleware') ? undefined : ('manual' as const)
  const generator = `${ctx.pluginName}@${ctx.pluginVersion}`

  return augmentMatchers(matchers, ctx).map((matcher) => ({
    function: functionHandlerName,
    name: functionName,
    pattern: matcher.regexp,
    cache,
    generator,
  }))
}

export const clearStaleEdgeHandlers = async (ctx: PluginContext) => {
  await rm(ctx.edgeFunctionsDir, { recursive: true, force: true })
}

export const createEdgeHandlers = async (ctx: PluginContext) => {
  // Edge middleware
  const nextManifest = await ctx.getMiddlewareManifest()
  // Node middleware
  const functionsConfigManifest = await ctx.getFunctionsConfigManifest()

  const nextDefinitions = [...Object.values(nextManifest.middleware)]
  await Promise.all(nextDefinitions.map((def) => createEdgeHandler(ctx, def)))

  const netlifyDefinitions = nextDefinitions.flatMap((def) => buildHandlerDefinition(ctx, def))

  if (functionsConfigManifest?.functions?.['/_middleware']) {
    const middlewareDefinition = functionsConfigManifest?.functions?.['/_middleware']
    const entry = 'server/middleware.js'
    const nft = `${entry}.nft.json`
    const name = 'node-middleware'

    // await copyHandlerDependencies(ctx, definition)
    const srcDir = join(ctx.standaloneDir, ctx.nextDistDir)
    // const destDir = join(ctx.edgeFunctionsDir, getHandlerName({ name }))

    // const fakeNodeModuleName = 'fake-module-with-middleware'

    // const fakeNodeModulePath = ctx.resolveFromPackagePath(join('node_modules', fakeNodeModuleName))

    const nftFilesPath = join(process.cwd(), ctx.nextDistDir, nft)
    const nftManifest = JSON.parse(await readFile(nftFilesPath, 'utf8'))

    const files: string[] = nftManifest.files.map((file: string) => join('server', file))
    files.push(entry)

    // files are relative to location of middleware entrypoint
    // we need to capture all of them
    // they might be going to parent directories, so first we check how many directories we need to go up
    const maxDirsUp = files.reduce((max, file) => {
      let dirsUp = 0
      for (const part of file.split('/')) {
        if (part === '..') {
          dirsUp += 1
        } else {
          break
        }
      }
      return Math.max(max, dirsUp)
    }, 0)

    let prefixPath = ''
    for (let nestedIndex = 1; nestedIndex <= maxDirsUp; nestedIndex++) {
      // TODO: ideally we preserve the original directory structure
      // this is just hack to use arbitrary computed names to speed up hooking things up
      prefixPath += `nested-${nestedIndex}/`
    }

    let virtualModules = ''
    for (const file of files) {
      const srcPath = join(srcDir, file)

      const content = await readFile(srcPath, 'utf8')

      virtualModules += `virtualModules.set(${JSON.stringify(join(prefixPath, file))}, ${JSON.stringify(content)});\n`

      // const destPath = join(fakeNodeModulePath, prefixPath, file)

      // await mkdir(dirname(destPath), { recursive: true })

      // if (file === entry) {
      //   const content = await readFile(srcPath, 'utf8')
      //   await writeFile(
      //     destPath,
      //     // Next.js needs to be set on global even if it's possible to just require it
      //     // so somewhat similar to existing shim we have for edge runtime
      //     `globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;\n${content}`,
      //   )
      // } else {
      //   await cp(srcPath, destPath, { force: true })
      // }
    }

    // await writeFile(join(fakeNodeModulePath, 'package.json'), JSON.stringify({ type: 'commonjs' }))

    // there is `/chunks/**/*` require coming from webpack-runtime that fails esbuild due to nothing matching,
    // so this ensure something does
    // const dummyChunkPath = join(fakeNodeModulePath, prefixPath, 'server', 'chunks', 'dummy.js')
    // await mkdir(dirname(dummyChunkPath), { recursive: true })
    // await writeFile(dummyChunkPath, '')

    // there is also `@opentelemetry/api` require that fails esbuild due to nothing matching,
    // next is try/catching it and fallback to bundled version of otel package in case of errors
    // const otelApiPath = join(
    //   fakeNodeModulePath,
    //   'node_modules',
    //   '@opentelemetry',
    //   'api',
    //   'index.js',
    // )
    // await mkdir(dirname(otelApiPath), { recursive: true })
    // await writeFile(
    //   otelApiPath,
    //   `throw new Error('this is dummy to satisfy esbuild used for npm compat using fake module')`,
    // )

    // await writeHandlerFile(ctx, definition)

    const nextConfig = ctx.buildConfig
    const handlerName = getHandlerName({ name })
    const handlerDirectory = join(ctx.edgeFunctionsDir, handlerName)
    const handlerRuntimeDirectory = join(handlerDirectory, 'edge-runtime')

    // Copying the runtime files. These are the compatibility layer between
    // Netlify Edge Functions and the Next.js edge runtime.
    await copyRuntime(ctx, handlerDirectory)

    // Writing a file with the matchers that should trigger this function. We'll
    // read this file from the function at runtime.
    await writeFile(
      join(handlerRuntimeDirectory, 'matchers.json'),
      JSON.stringify(middlewareDefinition.matchers ?? []),
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
        ctx.pluginDir,
        'edge-runtime/vendor/deno.land/x/htmlrewriter@v1.0.0/pkg/htmlrewriter_bg.wasm',
      ),
    )

    // Writing the function entry file. It wraps the middleware code with the
    // compatibility layer mentioned above.
    await writeFile(
      join(handlerDirectory, `${handlerName}.js`),
      `
    import { createRequire } from "node:module";
    import { init as htmlRewriterInit } from './edge-runtime/vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'
    import { handleMiddleware } from './edge-runtime/middleware.ts';
    import { registerCJSModules } from "./edge-runtime/lib/cjs.ts";
    import { AsyncLocalStorage } from 'node:async_hooks';

    globalThis.AsyncLocalStorage = AsyncLocalStorage;

    // needed for path.relative and path.resolve to work
    Deno.cwd = () => ''

    const virtualModules = new Map();
    ${virtualModules}
    registerCJSModules(import.meta.url, virtualModules);

    const require = createRequire(import.meta.url);
    const handlerMod = require("./${prefixPath}/${entry}");
    const handler = handlerMod.default || handlerMod;

    await htmlRewriterInit({ module_or_path: Uint8Array.from(${JSON.stringify([
      ...htmlRewriterWasm,
    ])}) });

    export default (req, context) => {
      return handleMiddleware(req, context, handler);
    };
    `,
    )

    // buildHandlerDefinition(ctx, def)
    const netlifyDefinitions: Manifest['functions'] = augmentMatchers(
      middlewareDefinition.matchers ?? [],
      ctx,
    ).map((matcher) => {
      return {
        function: getHandlerName({ name }),
        name: `Next.js Node Middleware Handler`,
        pattern: matcher.regexp,
        cache: undefined,
        generator: `${ctx.pluginName}@${ctx.pluginVersion}`,
      }
    })

    const netlifyManifest: Manifest = {
      version: 1,
      functions: netlifyDefinitions,
    }
    await writeEdgeManifest(ctx, netlifyManifest)

    return
  }

  const netlifyManifest: Manifest = {
    version: 1,
    functions: netlifyDefinitions,
  }
  await writeEdgeManifest(ctx, netlifyManifest)
}
