import { cp, lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path/posix'

import type { Manifest } from '@netlify/edge-functions'
import type { AdapterOutput } from 'next-with-adapters'

import type { SerializedAdapterOutput } from '../../adapter/adapter-output.js'
import { EDGE_HANDLER_NAME, PluginContext } from '../plugin-context.js'

import { copyRuntime, writeEdgeManifest } from './edge.js'

type MiddlewareOutput = AdapterOutput['MIDDLEWARE']

const ADAPTER_MIDDLEWARE_FUNCTION_NAME = 'adapter-middleware'

/**
 * Build edge handlers for adapter mode.
 *
 * When middleware exists, we create a single edge function that handles
 * **both** routing (`resolveRoutes`) and middleware invocation. This means
 * redirects/rewrites resolve at the edge, static asset requests go directly
 * to CDN, and only compute-requiring requests reach the server handler.
 */
export const createEdgeHandlersFromAdapter = async (ctx: PluginContext): Promise<void> => {
  console.log('running new stuff')
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const adapterOutput = ctx.adapterOutput!
  const middlewareOutput = adapterOutput.outputs.middleware

  if (!middlewareOutput) {
    // Future: could still create a routing-only edge function here
    // when user opts into edge routing without middleware.
    return
  }

  const handlerName = getAdapterHandlerName()
  const handlerDirectory = join(ctx.edgeFunctionsDir, handlerName)

  // Copy edge-runtime support files
  await copyRuntime(ctx, handlerDirectory)

  // Copy the pre-bundled next-routing ESM module (built by tools/build.js)
  // so the edge function can import it locally without needing npm resolution.
  // Preserves the same path hierarchy as in the repo: compiled/next-routing.js
  await mkdir(join(handlerDirectory, 'compiled'), { recursive: true })
  await cp(
    join(ctx.pluginDir, 'compiled/next-routing.js'),
    join(handlerDirectory, 'compiled/next-routing.js'),
  )

  console.log('middleware runtime', middlewareOutput.runtime)
  // Bundle the middleware handler
  await (middlewareOutput.runtime === 'edge'
    ? copyEdgeMiddlewareDependenciesFromAdapter(ctx, middlewareOutput, handlerDirectory)
    : copyNodeMiddlewareDependenciesFromAdapter(ctx, middlewareOutput, handlerDirectory))

  // Write the routing edge function entry file
  await writeRoutingEdgeFunctionEntry(ctx, adapterOutput, middlewareOutput, handlerDirectory)

  // Write edge manifest — match all requests
  const manifest: Manifest = {
    version: 1,
    functions: [
      {
        function: handlerName,
        name: 'Next.js Routing + Middleware',
        pattern: '.*',
        generator: `${ctx.pluginName}@${ctx.pluginVersion}`,
      },
    ],
  }
  await writeEdgeManifest(ctx, manifest)
}

function getAdapterHandlerName(): string {
  return `${EDGE_HANDLER_NAME}-${ADAPTER_MIDDLEWARE_FUNCTION_NAME}`
}

/**
 * Bundle edge-runtime middleware from adapter output assets.
 * Same concatenation pattern as standalone but using adapter asset paths.
 */
async function copyEdgeMiddlewareDependenciesFromAdapter(
  ctx: PluginContext,
  middlewareOutput: MiddlewareOutput,
  handlerDirectory: string,
): Promise<void> {
  const edgeRuntimeDir = join(ctx.pluginDir, 'edge-runtime')
  const shimPath = join(edgeRuntimeDir, 'shim/edge.js')
  const shim = await readFile(shimPath, 'utf8')

  const parts = [shim]
  const env = middlewareOutput.config?.env
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      parts.push(`process.env.${key} = '${value}';`)
    }
  }

  const { wasmAssets, assets, filePath: middlewareFilePath } = middlewareOutput
  if (wasmAssets) {
    for (const [name, filePath] of Object.entries(wasmAssets)) {
      const data = await readFile(filePath)
      parts.push(`const ${name} = Uint8Array.from(${JSON.stringify([...data])})`)
    }
  }

  // Read JS files from adapter assets — keys are relative paths, values are absolute paths
  for (const [relPath, absPath] of Object.entries(assets)) {
    if (!relPath.endsWith('.js')) continue
    const entrypoint = await readFile(absPath, 'utf8')
    parts.push(`;// Concatenated file: ${relPath} \n`, entrypoint)
  }

  // The middleware entry is at filePath (relative to repoRoot in adapter output)
  const middlewareEntry = await readFile(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    join(ctx.adapterOutput!.repoRoot, middlewareFilePath),
    'utf8',
  )
  parts.push(
    `;// Middleware entry: ${middlewareFilePath} \n`,
    middlewareEntry,
    `const middlewareEntryKey = Object.keys(_ENTRIES).find(entryKey => entryKey.startsWith("middleware_"));`,
    `export default await _ENTRIES[middlewareEntryKey].default;`,
  )

  const name = 'middleware'
  const outputFile = join(handlerDirectory, `server/${name}.js`)
  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, parts.join('\n'))
}

/**
 * Bundle Node.js middleware from adapter output assets.
 * Same virtual-module pattern as standalone but using adapter asset paths.
 */
async function copyNodeMiddlewareDependenciesFromAdapter(
  ctx: PluginContext,
  middlewareOutput: MiddlewareOutput,
  handlerDirectory: string,
): Promise<void> {
  const edgeRuntimeDir = join(ctx.pluginDir, 'edge-runtime')
  const shimPath = join(edgeRuntimeDir, 'shim/node.js')
  const shim = await readFile(shimPath, 'utf8')

  const parts = [shim]

  // Collect all asset files — keys are relative to repoRoot, values are absolute paths
  const files: Array<{ relPath: string; absPath: string }> = []
  const unsupportedDotNodeModules: string[] = []

  for (const [relPath, absPath] of Object.entries(middlewareOutput.assets)) {
    if (relPath.endsWith('.node')) {
      unsupportedDotNodeModules.push(absPath)
    }
    files.push({ relPath, absPath })
  }

  // Also include the middleware entrypoint itself
  files.push({
    relPath: middlewareOutput.filePath,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    absPath: join(ctx.adapterOutput!.repoRoot, middlewareOutput.filePath),
  })

  if (unsupportedDotNodeModules.length !== 0) {
    throw new Error(
      `Usage of unsupported C++ Addon(s) found in Node.js Middleware:\n${unsupportedDotNodeModules.map((file) => `- ${file}`).join('\n')}\n\nCheck https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/#limitations for more information.`,
    )
  }

  parts.push(`const virtualModules = new Map();`, `const virtualSymlinks = new Map();`)

  const handleFileOrDirectory = async (relPath: string, absPath: string) => {
    const stats = await lstat(absPath)
    if (stats.isDirectory()) {
      const filesInDir = await readdir(absPath)
      for (const fileInDir of filesInDir) {
        await handleFileOrDirectory(join(relPath, fileInDir), join(absPath, fileInDir))
      }
    } else if (stats.isSymbolicLink()) {
      const symlinkTarget = await readlink(absPath)
      parts.push(
        `virtualSymlinks.set(${JSON.stringify(relPath)}, ${JSON.stringify(symlinkTarget)});`,
      )
    } else {
      const content = await readFile(absPath, 'utf8')
      parts.push(`virtualModules.set(${JSON.stringify(relPath)}, ${JSON.stringify(content)});`)
    }
  }

  for (const { relPath, absPath } of files) {
    await handleFileOrDirectory(relPath, absPath)
  }

  parts.push(`registerCJSModules(import.meta.url, virtualModules, virtualSymlinks);

    const require = createRequire(import.meta.url);
    const handlerMod = require("./${middlewareOutput.filePath}");
    const handler = handlerMod.default || handlerMod;

    export default handler
    `)

  const name = 'middleware'
  const outputFile = join(handlerDirectory, `server/${name}.js`)
  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, parts.join('\n'))
}

/**
 * Write the routing + middleware edge function entry file.
 *
 * This entry file imports the routing runtime and the bundled middleware handler,
 * serializes routing config at build time, and delegates to `runNextRouting`
 * at request time.
 */
async function writeRoutingEdgeFunctionEntry(
  ctx: PluginContext,
  adapterOutput: SerializedAdapterOutput,
  middlewareOutput: MiddlewareOutput,
  handlerDirectory: string,
): Promise<void> {
  const nextConfig = ctx.buildConfig
  const handlerName = getAdapterHandlerName()

  // Write the routing config as a JSON file for the edge function to import
  const routingConfig = {
    buildId: adapterOutput.buildId,
    basePath: adapterOutput.config.basePath || '',
    i18n: adapterOutput.config.i18n ?? null,
    routes: adapterOutput.routing,
    pathnames: collectAllPathnames(adapterOutput),
    skipProxyUrlNormalize:
      adapterOutput.config.skipProxyUrlNormalize ?? adapterOutput.config.skipMiddlewareUrlNormalize,
  }

  await writeFile(join(handlerDirectory, 'routing-config.json'), JSON.stringify(routingConfig))

  // Write minimal next config for middleware request building
  const minimalNextConfig = {
    basePath: nextConfig.basePath,
    i18n: nextConfig.i18n,
    trailingSlash: nextConfig.trailingSlash,
    skipMiddlewareUrlNormalize:
      nextConfig.skipProxyUrlNormalize ?? nextConfig.skipMiddlewareUrlNormalize,
  }

  const handlerRuntimeDirectory = join(handlerDirectory, 'edge-runtime')
  await writeFile(
    join(handlerRuntimeDirectory, 'next.config.json'),
    JSON.stringify(minimalNextConfig),
  )

  // Build matcher regexes from middleware config
  const matchers = middlewareOutput.config?.matchers ?? []
  const matcherRegexes = matchers.map((matcher) => matcher.sourceRegex)

  // Also write matchers.json for the existing handleMiddleware (fallback)
  // We re-use the same format the standalone middleware uses
  const edgeStyleMatchers = matchers.map((matcher) => ({
    regexp: matcher.sourceRegex,
    originalSource: matcher.source,
    has: matcher.has,
    missing: matcher.missing,
  }))
  await writeFile(join(handlerRuntimeDirectory, 'matchers.json'), JSON.stringify(edgeStyleMatchers))

  // Write the entry file
  await writeFile(
    join(handlerDirectory, `${handlerName}.js`),
    `
    import { runNextRouting } from './edge-runtime/routing.ts';
    import middlewareHandler from './server/middleware.js';
    import routingConfig from './routing-config.json' with { type: 'json' };
    import nextConfig from './edge-runtime/next.config.json' with { type: 'json' };

    const matcherRegexes = ${JSON.stringify(matcherRegexes)}.map(re => new RegExp(re));

    const middlewareConfig = {
      enabled: true,
      matchers: matcherRegexes,
      load: () => Promise.resolve(middlewareHandler),
    };

    export default (req, context) => runNextRouting(req, context, routingConfig, middlewareConfig, nextConfig);
    export const config = { pattern: '.*' };
    `,
  )
}

/**
 * Collect all pathnames from the adapter output for route resolution.
 */
function collectAllPathnames(adapterOutput: SerializedAdapterOutput): string[] {
  const pathnames = new Set<string>()

  for (const output of adapterOutput.outputs.pages) {
    pathnames.add(output.pathname)
  }
  for (const output of adapterOutput.outputs.pagesApi) {
    pathnames.add(output.pathname)
  }
  for (const output of adapterOutput.outputs.appPages) {
    pathnames.add(output.pathname)
  }
  for (const output of adapterOutput.outputs.appRoutes) {
    pathnames.add(output.pathname)
  }
  for (const output of adapterOutput.outputs.prerenders) {
    pathnames.add(output.pathname)
  }
  for (const output of adapterOutput.outputs.staticFiles) {
    pathnames.add(output.pathname)
  }

  return [...pathnames]
}
