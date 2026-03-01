import { cp, lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path/posix'

import type { Manifest, ManifestFunction } from '@netlify/edge-functions'
import { glob } from 'fast-glob'
import type { FunctionsConfigManifest } from 'next-with-cache-handler-v2/dist/build/index.js'
import type { EdgeFunctionDefinition as EdgeMiddlewareDefinition } from 'next-with-cache-handler-v2/dist/build/webpack/plugins/middleware-plugin.js'
import { pathToRegexp } from 'path-to-regexp'

import { EDGE_HANDLER_NAME, PluginContext } from '../plugin-context.js'

type NodeMiddlewareDefinitionWithOptionalMatchers = FunctionsConfigManifest['functions'][0]
type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] }
type NodeMiddlewareDefinition = WithRequired<
  NodeMiddlewareDefinitionWithOptionalMatchers,
  'matchers'
>

function nodeMiddlewareDefinitionHasMatcher(
  definition: NodeMiddlewareDefinitionWithOptionalMatchers,
): definition is NodeMiddlewareDefinition {
  return Array.isArray(definition.matchers)
}

export type EdgeOrNodeMiddlewareDefinition = {
  runtime: 'nodejs' | 'edge'
  // hoisting shared properties from underlying definitions for common handling
  name: string
  matchers: EdgeMiddlewareDefinition['matchers']
} & (
  | {
      runtime: 'nodejs'
      functionDefinition: NodeMiddlewareDefinition
    }
  | {
      runtime: 'edge'
      functionDefinition: EdgeMiddlewareDefinition
    }
)

export const writeEdgeManifest = async (ctx: PluginContext, manifest: Manifest) => {
  await mkdir(ctx.edgeFunctionsDir, { recursive: true })
  await writeFile(join(ctx.edgeFunctionsDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

export const copyRuntime = async (ctx: PluginContext, handlerDirectory: string): Promise<void> => {
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
export const augmentMatchers = (
  matchers: EdgeMiddlewareDefinition['matchers'],
  ctx: PluginContext,
): EdgeMiddlewareDefinition['matchers'] => {
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

export const writeHandlerFile = async (
  ctx: PluginContext,
  { matchers, name }: EdgeOrNodeMiddlewareDefinition,
) => {
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
    skipMiddlewareUrlNormalize:
      nextConfig.skipProxyUrlNormalize ?? nextConfig.skipMiddlewareUrlNormalize,
  }

  await writeFile(
    join(handlerRuntimeDirectory, 'next.config.json'),
    JSON.stringify(minimalNextConfig),
  )

  // Writing the function entry file. It wraps the middleware code with the
  // compatibility layer mentioned above.
  await writeFile(
    join(handlerDirectory, `${handlerName}.js`),
    `
    import { handleMiddleware } from './edge-runtime/middleware.ts';
    import handler from './server/${name}.js';

    export default (req, context) => handleMiddleware(req, context, handler);
    `,
  )
}

const copyHandlerDependenciesForEdgeMiddleware = async (
  ctx: PluginContext,
  { name, env, files, wasm }: EdgeMiddlewareDefinition,
) => {
  const srcDir = join(ctx.standaloneDir, ctx.nextDistDir)
  const destDir = join(ctx.edgeFunctionsDir, getHandlerName({ name }))

  const edgeRuntimeDir = join(ctx.pluginDir, 'edge-runtime')
  const shimPath = join(edgeRuntimeDir, 'shim/edge.js')
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

const copyHandlerDependenciesForNodeMiddleware = async (ctx: PluginContext) => {
  const name = NODE_MIDDLEWARE_NAME

  const srcDir = join(ctx.standaloneDir, ctx.nextDistDir)
  const destDir = join(ctx.edgeFunctionsDir, getHandlerName({ name }))

  const edgeRuntimeDir = join(ctx.pluginDir, 'edge-runtime')
  const shimPath = join(edgeRuntimeDir, 'shim/node.js')
  const shim = await readFile(shimPath, 'utf8')

  const parts = [shim]

  const entry = 'server/middleware.js'
  const nft = `${entry}.nft.json`
  const nftFilesPath = join(ctx.publishDir, nft)
  const nftManifest = JSON.parse(await readFile(nftFilesPath, 'utf8'))

  const files: string[] = nftManifest.files.map((file: string) => join('server', file))
  files.push(entry)

  // files are relative to location of middleware entrypoint
  // we need to capture all of them
  // they might be going to parent directories, so first we check how many directories we need to go up
  const { maxParentDirectoriesPath, unsupportedDotNodeModules } = files.reduce(
    (acc, file) => {
      let dirsUp = 0
      let parentDirectoriesPath = ''
      for (const part of file.split('/')) {
        if (part === '..') {
          dirsUp += 1
          parentDirectoriesPath += '../'
        } else {
          break
        }
      }

      if (file.endsWith('.node')) {
        // C++ addons are not supported
        acc.unsupportedDotNodeModules.push(join(srcDir, file))
      }

      if (dirsUp > acc.maxDirsUp) {
        return {
          ...acc,
          maxDirsUp: dirsUp,
          maxParentDirectoriesPath: parentDirectoriesPath,
        }
      }

      return acc
    },
    { maxDirsUp: 0, maxParentDirectoriesPath: '', unsupportedDotNodeModules: [] as string[] },
  )

  if (unsupportedDotNodeModules.length !== 0) {
    throw new Error(
      `Usage of unsupported C++ Addon(s) found in Node.js Middleware:\n${unsupportedDotNodeModules.map((file) => `- ${file}`).join('\n')}\n\nCheck https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/#limitations for more information.`,
    )
  }

  const commonPrefix = relative(join(srcDir, maxParentDirectoriesPath), srcDir)

  parts.push(`const virtualModules = new Map();`, `const virtualSymlinks = new Map();`)

  const handleFileOrDirectory = async (fileOrDir: string) => {
    const srcPath = join(srcDir, fileOrDir)

    const stats = await lstat(srcPath)
    if (stats.isDirectory()) {
      const filesInDir = await readdir(srcPath)
      for (const fileInDir of filesInDir) {
        await handleFileOrDirectory(join(fileOrDir, fileInDir))
      }
    } else if (stats.isSymbolicLink()) {
      const symlinkTarget = await readlink(srcPath)
      parts.push(
        `virtualSymlinks.set(${JSON.stringify(join(commonPrefix, fileOrDir))}, ${JSON.stringify(symlinkTarget)});`,
      )
    } else {
      const content = await readFile(srcPath, 'utf8')

      parts.push(
        `virtualModules.set(${JSON.stringify(join(commonPrefix, fileOrDir))}, ${JSON.stringify(content)});`,
      )
    }
  }

  for (const file of files) {
    await handleFileOrDirectory(file)
  }
  parts.push(`registerCJSModules(import.meta.url, virtualModules, virtualSymlinks);

    const require = createRequire(import.meta.url);
    const handlerMod = require("./${join(commonPrefix, entry)}");
    const handler = handlerMod.default || handlerMod;

    export default handler
    `)

  const outputFile = join(destDir, `server/${name}.js`)

  await mkdir(dirname(outputFile), { recursive: true })

  await writeFile(outputFile, parts.join('\n'))
}

const createEdgeHandler = async (
  ctx: PluginContext,
  definition: EdgeOrNodeMiddlewareDefinition,
): Promise<void> => {
  await (definition.runtime === 'edge'
    ? copyHandlerDependenciesForEdgeMiddleware(ctx, definition.functionDefinition)
    : copyHandlerDependenciesForNodeMiddleware(ctx))
  await writeHandlerFile(ctx, definition)
}

export const getHandlerName = ({ name }: Pick<EdgeMiddlewareDefinition, 'name'>): string =>
  `${EDGE_HANDLER_NAME}-${name.replace(/\W/g, '-')}`

export const NODE_MIDDLEWARE_NAME = 'node-middleware'

export const buildHandlerDefinition = (
  ctx: PluginContext,
  def: EdgeOrNodeMiddlewareDefinition,
): Array<ManifestFunction> => {
  return augmentMatchers(def.matchers, ctx).map((matcher) => ({
    function: getHandlerName({ name: def.name }),
    name: 'Next.js Middleware Handler',
    pattern: matcher.regexp,
    generator: `${ctx.pluginName}@${ctx.pluginVersion}`,
  }))
}

export const clearStaleEdgeHandlers = async (ctx: PluginContext) => {
  await rm(ctx.edgeFunctionsDir, { recursive: true, force: true })
}

export const createEdgeHandlers = async (ctx: PluginContext) => {
  console.log('running old stuff')
  if (ctx.hasAdapter()) {
    throw new Error('createEdgeHandlers should not be used when adapter is enabled')
  }

  // Edge middleware
  const nextManifest = await ctx.getMiddlewareManifest()
  const middlewareDefinitions: EdgeOrNodeMiddlewareDefinition[] = [
    ...Object.values(nextManifest.middleware),
  ].map((edgeDefinition) => {
    return {
      runtime: 'edge',
      functionDefinition: edgeDefinition,
      name: edgeDefinition.name,
      matchers: edgeDefinition.matchers,
    }
  })

  // Node middleware
  const functionsConfigManifest = await ctx.getFunctionsConfigManifest()
  if (
    functionsConfigManifest?.functions?.['/_middleware'] &&
    nodeMiddlewareDefinitionHasMatcher(functionsConfigManifest?.functions?.['/_middleware'])
  ) {
    middlewareDefinitions.push({
      runtime: 'nodejs',
      functionDefinition: functionsConfigManifest?.functions?.['/_middleware'],
      name: NODE_MIDDLEWARE_NAME,
      matchers: functionsConfigManifest?.functions?.['/_middleware']?.matchers,
    })
  }

  await Promise.all(middlewareDefinitions.map((def) => createEdgeHandler(ctx, def)))

  const netlifyDefinitions = middlewareDefinitions.flatMap((def) =>
    buildHandlerDefinition(ctx, def),
  )

  const netlifyManifest: Manifest = {
    version: 1,
    functions: netlifyDefinitions,
  }
  await writeEdgeManifest(ctx, netlifyManifest)
}
