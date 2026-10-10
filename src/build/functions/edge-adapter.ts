import { cp, lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path/posix'

import type { Manifest } from '@netlify/edge-functions'
import type { AdapterOutput } from 'next-with-adapters'

import type { AdapterBuildCompleteContext } from '../../adapter/adapter-output.js'
import type { RoutingConfig } from '../../adapter-runtime-shared/next-routing.js'
import { isGroupEntry } from '../content/prerendered.js'
import { getPublishedPath, isStatusPagePathname } from '../content/static.js'
import { EDGE_HANDLER_NAME, PluginContextAdapter } from '../plugin-context.js'

import { writeEdgeManifest } from './edge.js'

type MiddlewareOutput = AdapterOutput['MIDDLEWARE']

const ADAPTER_MIDDLEWARE_FUNCTION_NAME = 'adapter-middleware'

/**
 * Build edge handlers for adapter mode.
 *
 * A single edge function in front of every request handles routing (`resolveRoutes`) and, when the
 * app has it, middleware invocation. Routing has to run before the CDN looks for a file, or the
 * CDN's own URL normalization (pretty URLs, trailing slashes) answers first. Redirects and rewrites
 * resolve at the edge, static outputs are forwarded to the CDN, and only compute-requiring requests
 * reach the server handler.
 */
export const createEdgeHandlersFromAdapter = async (ctx: PluginContextAdapter): Promise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const adapterOutput = ctx.adapterOutput!
  const middlewareOutput = adapterOutput.outputs.middleware

  const handlerName = getAdapterHandlerName()
  const handlerDirectory = join(ctx.edgeFunctionsDir, handlerName)

  // Copy:
  // - adapter-runtime-edge source files (Deno runs .ts directly)
  // - adapter-runtime-shared modules (built by tools/build.js, used by both serverless and edge runtimes)
  // - adapter-runtime-chunks (built by tools/build.js, dependencies of source files)
  await Promise.all(
    ['adapter-runtime-edge', 'adapter-runtime-shared', 'adapter-runtime-chunks'].map((dirName) =>
      cp(join(ctx.pluginDir, 'dist', dirName), join(handlerDirectory, dirName), {
        recursive: true,
      }),
    ),
  )

  if (middlewareOutput) {
    // Copy edge-runtime shim files and cjs.ts needed for middleware bundling
    const edgeRuntimeDir = join(ctx.pluginDir, 'edge-runtime')
    const handlerEdgeRuntimeDir = join(handlerDirectory, 'edge-runtime')
    await mkdir(join(handlerEdgeRuntimeDir, 'shim'), { recursive: true })
    await mkdir(join(handlerEdgeRuntimeDir, 'lib'), { recursive: true })
    await Promise.all([
      cp(join(edgeRuntimeDir, 'shim/edge.js'), join(handlerEdgeRuntimeDir, 'shim/edge.js')),
      cp(join(edgeRuntimeDir, 'shim/node.js'), join(handlerEdgeRuntimeDir, 'shim/node.js')),
      cp(join(edgeRuntimeDir, 'lib/cjs.ts'), join(handlerEdgeRuntimeDir, 'lib/cjs.ts')),
    ])

    // Bundle the middleware handler
    await (middlewareOutput.runtime === 'edge'
      ? copyEdgeMiddlewareDependenciesFromAdapter(ctx, middlewareOutput, handlerDirectory)
      : copyNodeMiddlewareDependenciesFromAdapter(ctx, middlewareOutput, handlerDirectory))
  }

  // Write the routing edge function entry file
  await writeRoutingEdgeFunctionEntry(ctx, Boolean(middlewareOutput), handlerDirectory)

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
  ctx: PluginContextAdapter,
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

  const {
    wasmAssets,
    assets,
    filePath: middlewareFilePath,
    id: middlewareId,
    edgeRuntime,
  } = middlewareOutput
  if (wasmAssets) {
    for (const [name, filePath] of Object.entries(wasmAssets)) {
      const data = await readFile(filePath)
      // a compiled module, like Next's own sandbox binds (`loadWasm`): with raw bytes
      // `WebAssembly.instantiate(wasm)` resolves to `{ module, instance }` instead of the instance,
      // so the `const { exports } = await WebAssembly.instantiate(wasm)` that Next compiles the
      // `import wasm from './x.wasm?module'` into gets `exports: undefined`
      parts.push(
        `const ${name} = await WebAssembly.compile(Uint8Array.from(atob(${JSON.stringify(data.toString('base64'))}), (character) => character.charCodeAt(0)))`,
      )
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
  // The adapter output names the entry and its handler (`edgeRuntime`): the bundle also registers
  // the instrumentation hook in `_ENTRIES`, so the entry can't be guessed from the key prefix
  const { entryKey, handlerExport } = edgeRuntime ?? {
    entryKey: `middleware_${middlewareId}`,
    handlerExport: 'handler',
  }
  parts.push(
    `;// Middleware entry: ${middlewareFilePath} \n`,
    middlewareEntry,
    // turbopack entries are promises so we await here to get actual entry
    // non-turbopack entries are already resolved, so await does not change anything
    `export default (await _ENTRIES[${JSON.stringify(entryKey)}])[${JSON.stringify(handlerExport)}];`,
  )

  // `new URL('./font.ttf', import.meta.url)` compiles to `blob:<asset name>`, which Next's sandbox
  // answers from the output's assets (`fetchInlineAsset`). Deno can't fetch that, and the throw
  // takes the whole edge function down, so inline the asset as a `data:` URL, which it can.
  let bundle = parts.join('\n')
  for (const [key, absPath] of Object.entries(assets)) {
    if (!key.endsWith('.js') && bundle.includes(`blob:${key}`)) {
      const data = await readFile(absPath)
      bundle = bundle.replaceAll(
        `blob:${key}`,
        `data:application/octet-stream;base64,${data.toString('base64')}`,
      )
    }
  }

  const name = 'middleware'
  const outputFile = join(handlerDirectory, `server/${name}.js`)
  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, bundle)
}

/**
 * Bundle Node.js middleware from adapter output assets.
 * Same virtual-module pattern as standalone but using adapter asset paths.
 */
async function copyNodeMiddlewareDependenciesFromAdapter(
  ctx: PluginContextAdapter,
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

  // Next's middleware wrapper requires the instrumentation hook from `process.cwd()` (the project
  // dir under `next start`), so point it at the project dir among the virtual modules, which are
  // registered relative to this file
  const relativeProjectDir = relative(ctx.adapterOutput.repoRoot, ctx.adapterOutput.projectDir)
  parts.push(
    `process.cwd = () => decodeURIComponent(new URL(${JSON.stringify(relativeProjectDir ? `./${relativeProjectDir}/` : './')}, import.meta.url).pathname).replace(/\\/$/, '');`,
    `registerCJSModules(import.meta.url, virtualModules, virtualSymlinks);

    const require = createRequire(import.meta.url);
    // middleware with top-level await compiles to a module whose require() returns a Promise
    const handlerMod = await require("./${middlewareOutput.filePath}");
    const handler = handlerMod.handler;

    export default handler
    `,
  )

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
  ctx: PluginContextAdapter,
  hasMiddleware: boolean,
  handlerDirectory: string,
): Promise<void> {
  const handlerName = getAdapterHandlerName()

  // Write the routing config as a JSON file for the edge function to import
  await writeFile(
    join(handlerDirectory, 'routing-config.json'),
    JSON.stringify(await getRoutingConfig(ctx)),
  )

  // Write the entry file
  await writeFile(
    join(handlerDirectory, `${handlerName}.js`),
    `
    import { runNextRouting } from './adapter-runtime-edge/middleware.js';
    import { setupHoneycombTracing, withHoneycombTracing } from './adapter-runtime-edge/honeycomb-tracing.js';
    import routingConfig from './routing-config.json' with { type: 'json' };

    let middlewareHandlerPromise = undefined

    const middlewareConfig = ${
      hasMiddleware
        ? `{
      enabled: true,
      load: () => {
        if (!middlewareHandlerPromise) {
          middlewareHandlerPromise = import('./server/middleware.js').then(mod => mod.default)
        }
        return middlewareHandlerPromise
      }
    }`
        : // the bundler follows the import even when it would never run
          `{ enabled: false }`
    };

    await setupHoneycombTracing('next-runtime-edge');

    export default (req, context) =>
      withHoneycombTracing(req, context.waitUntil?.bind(context), () =>
        runNextRouting(req, context, routingConfig, middlewareConfig),
      );
    export const config = { pattern: '.*' };
    `,
  )
}

export async function getRoutingConfig(ctx: PluginContextAdapter): Promise<RoutingConfig> {
  const { buildId, config, outputs, routing } = ctx.adapterOutput
  // `public/` files are not adapter outputs, routing treats them like static files
  const publicPathnames = await ctx.getPublicPathnames()
  return {
    buildId,
    basePath: config.basePath || '',
    // next-with-adapters types the i18n arrays readonly
    i18n: (config.i18n ?? undefined) as RoutingConfig['i18n'],
    trailingSlash: config.trailingSlash,
    skipMiddlewareUrlNormalize: config.skipProxyUrlNormalize ?? config.skipMiddlewareUrlNormalize,
    routes: {
      ...routing,
      caseSensitive: config.experimental?.caseSensitiveRoutes,
    },
    pathnames: [
      ...collectPathnames(ctx.adapterOutput),
      ...publicPathnames.map((pathname) => ({ pathname, type: 'STATIC_FILE' as const })),
    ],
    ppr: Object.fromEntries(
      outputs.prerenders.flatMap((output) =>
        output.pprChain && isGroupEntry(output, ctx)
          ? [
              [
                output.pathname,
                { resumeHeaders: output.pprChain.headers, bypassFor: output.config.bypassFor },
              ],
            ]
          : [],
      ),
    ),
    publishedPaths: Object.fromEntries(
      outputs.staticFiles
        .map(({ pathname, filePath }) => [pathname, getPublishedPath(pathname, filePath, config)])
        // a direct request for the 404/500 page gets its status from a forced rule on its pathname
        .filter(
          ([pathname, publishedPath]) =>
            publishedPath !== pathname && !isStatusPagePathname(pathname, config),
        ),
    ),
  }
}

/**
 * Output pathnames with their output type, for route resolution.
 */
function collectPathnames(adapterOutput: AdapterBuildCompleteContext): RoutingConfig['pathnames'] {
  const { outputs } = adapterOutput
  return [
    ...outputs.pages,
    ...outputs.pagesApi,
    ...outputs.appPages,
    ...outputs.appRoutes,
    ...outputs.prerenders,
    ...outputs.staticFiles,
  ].map((output) =>
    // params come from the route a prerender renders: `/en/posts/[slug]` may be a shell of
    // `/[locale]/posts/[slug]`
    'route' in output && output.route !== output.pathname
      ? { pathname: output.pathname, type: output.type, route: output.route }
      : { pathname: output.pathname, type: output.type },
  )
}
