import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { sep as posixSep } from 'node:path/posix'

import type { Manifest, ManifestFunction } from '@netlify/edge-functions'
import { glob } from 'fast-glob'
import type { EdgeFunctionDefinition as NextDefinition } from 'next/dist/build/webpack/plugins/middleware-plugin.js'
import { pathToRegexp } from 'path-to-regexp'

import { EDGE_HANDLER_NAME, PluginContext } from '../plugin-context.js'

const toPosixPath = (path: string) => path.split(sep).join(posixSep)

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
  if (!ctx.buildConfig.i18n) {
    return matchers
  }
  return matchers.flatMap((matcher) => {
    if (matcher.originalSource && matcher.locale !== false) {
      return [
        matcher,
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
    import { decode as _base64Decode } from './edge-runtime/vendor/deno.land/std@0.175.0/encoding/base64.ts';
    import { init as htmlRewriterInit } from './edge-runtime/vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'
    import {handleMiddleware} from './edge-runtime/middleware.ts';
    import handler from './server/${name}.js';

    await htmlRewriterInit({ module_or_path: _base64Decode(${JSON.stringify(
      htmlRewriterWasm.toString('base64'),
    )}).buffer });

    export default (req, context) => handleMiddleware(req, context, handler);
    `,
  )
}

const copyHandlerDependencies = async (
  ctx: PluginContext,
  { name, files, wasm }: NextDefinition,
) => {
  const srcDir = join(ctx.standaloneDir, ctx.nextDistDir)
  const destDir = join(ctx.edgeFunctionsDir, getHandlerName({ name }))

  const edgeRuntimeDir = join(ctx.pluginDir, 'edge-runtime')
  const shimPath = join(edgeRuntimeDir, 'shim/index.js')
  const shim = await readFile(shimPath, 'utf8')

  const parts = [shim]

  const outputFile = join(destDir, `server/${name}.js`)

  if (wasm?.length) {
    const base64ModulePath = join(
      destDir,
      'edge-runtime/vendor/deno.land/std@0.175.0/encoding/base64.ts',
    )

    const base64ModulePathRelativeToOutputFile = toPosixPath(
      relative(dirname(outputFile), base64ModulePath),
    )

    parts.push(`import { decode as _base64Decode } from "${base64ModulePathRelativeToOutputFile}";`)
    for (const wasmChunk of wasm ?? []) {
      const data = await readFile(join(srcDir, wasmChunk.filePath))
      parts.push(
        `const ${wasmChunk.name} = _base64Decode(${JSON.stringify(
          data.toString('base64'),
        )}).buffer`,
      )
    }
  }

  for (const file of files) {
    const entrypoint = await readFile(join(srcDir, file), 'utf8')
    parts.push(`;// Concatenated file: ${file} \n`, entrypoint)
  }
  const exports = `const middlewareEntryKey = Object.keys(_ENTRIES).find(entryKey => entryKey.startsWith("middleware_${name}")); export default _ENTRIES[middlewareEntryKey].default;`
  await mkdir(dirname(outputFile), { recursive: true })

  await writeFile(outputFile, [...parts, exports].join('\n'))
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
  const fun = getHandlerName({ name })
  const funName = name.endsWith('middleware')
    ? 'Next.js Middleware Handler'
    : `Next.js Edge Handler: ${page}`
  const cache = name.endsWith('middleware') ? undefined : ('manual' as const)
  const generator = `${ctx.pluginName}@${ctx.pluginVersion}`

  return augmentMatchers(matchers, ctx).map((matcher) => ({
    function: fun,
    name: funName,
    pattern: matcher.regexp,
    cache,
    generator,
  }))
}

export const clearStaleEdgeHandlers = async (ctx: PluginContext) => {
  await rm(ctx.edgeFunctionsDir, { recursive: true, force: true })
}

export const createEdgeHandlers = async (ctx: PluginContext) => {
  const nextManifest = await ctx.getMiddlewareManifest()
  const nextDefinitions = [
    ...Object.values(nextManifest.middleware),
    // ...Object.values(nextManifest.functions)
  ]
  await Promise.all(nextDefinitions.map((def) => createEdgeHandler(ctx, def)))

  const netlifyDefinitions = nextDefinitions.flatMap((def) => buildHandlerDefinition(ctx, def))
  const netlifyManifest: Manifest = {
    version: 1,
    functions: netlifyDefinitions,
  }
  await writeEdgeManifest(ctx, netlifyManifest)
}
