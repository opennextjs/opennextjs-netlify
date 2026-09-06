// Runs `runtime: 'edge'` outputs inside the Node.js function using Next's edge sandbox, the same
// way `NextNodeServer.runEdgeFunction` does in `next start` / standalone. The sandbox is bundled
// from our pinned next-with-adapters rather than taken from the app's Next.js, so it's prepared at
// package build time and the app's Next.js only provides the edge bundles it evaluates. Self-contained
// on purpose: delete this module (and its call site in server-adapter.ts, plus
// build/content/edge-runtime-sandbox.ts) once edge outputs get a native home.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import type { MiddlewareManifest } from 'next-with-adapters/dist/build/webpack/plugins/middleware-plugin.js'

import type { AdapterManifest } from '../config.js'
import { PLUGIN_DIR } from '../constants.js'

import type { RequestContext } from './request-context.cjs'

type EdgeFunctionDefinition = MiddlewareManifest['functions'][string]
type Sandbox = typeof import('next-with-adapters/dist/server/web/sandbox/index.js')
type SandboxRunParams = Parameters<Sandbox['run']>[0]

let sandboxPromise: Promise<Sandbox> | undefined
// loaded lazily (still bundled): Next's async-local-storage asserts globalThis.AsyncLocalStorage at
// module evaluation, which server-adapter.ts only sets up after its imports are done. The sandbox is
// CommonJS, so outside of vitest its exports sit under `default`.
const getSandbox = () =>
  (sandboxPromise ??= import('next-with-adapters/dist/server/web/sandbox/index.js').then(
    (sandbox) => (sandbox as Sandbox & { default?: Sandbox }).default ?? sandbox,
  ))

let edgeFunctionsPromise: Promise<Record<string, EdgeFunctionDefinition>> | undefined

function getEdgeFunctions(distDir: string) {
  edgeFunctionsPromise ??= readFile(join(distDir, 'server/middleware-manifest.json'), 'utf-8').then(
    (content) => (JSON.parse(content) as MiddlewareManifest).functions,
  )
  return edgeFunctionsPromise
}

export async function invokeEdgeRuntimeOutput({
  outputId,
  request,
  requestContext,
  manifest,
  query,
  routeParams,
}: {
  outputId: string
  request: Request
  requestContext: RequestContext
  manifest: AdapterManifest
  query?: Record<string, string | string[]>
  routeParams?: Record<string, string>
}): Promise<Response> {
  // PLUGIN_DIR is the app dir inside the handler, distDir is relative to it
  const distDir = join(PLUGIN_DIR, manifest.config.distDir)
  const edgeFunction = Object.values(await getEdgeFunctions(distDir)).find(
    (definition) => definition.name === outputId,
  )
  if (!edgeFunction) {
    throw new Error(`Edge function "${outputId}" not found in middleware-manifest.json`)
  }

  // like runEdgeFunction: the entrypoint sees the requested URL with rewrite-added query and route
  // params merged into its query
  const url = new URL(request.url)
  for (const [key, valueOrValues] of Object.entries(query ?? {})) {
    url.searchParams.delete(key)
    for (const value of Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues]) {
      url.searchParams.append(key, value)
    }
  }
  for (const [key, value] of Object.entries(routeParams ?? {})) {
    url.searchParams.set(key, value)
  }

  const hasBody = !['GET', 'HEAD'].includes(request.method)
  const body: SandboxRunParams['request']['body'] = hasBody
    ? {
        finalize: async () => {
          // nothing to release, the body is cloned from the web request
        },
        cloneBodyStream: () =>
          Readable.fromWeb(
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            request.clone().body! as import('node:stream/web').ReadableStream,
          ),
      }
    : undefined

  const { run } = await getSandbox()
  const result = await run({
    distDir,
    name: edgeFunction.name,
    paths: edgeFunction.files.map((file) => join(distDir, file)),
    edgeFunctionEntry: {
      assets: edgeFunction.assets ?? [],
      env: edgeFunction.env ?? {},
      // sandbox reads wasm bindings by filePath as-is, assets are resolved against distDir
      wasm: (edgeFunction.wasm ?? []).map((binding) => ({
        ...binding,
        filePath: join(distDir, binding.filePath),
      })),
    },
    request: {
      headers: Object.fromEntries(request.headers),
      method: request.method,
      nextConfig: {
        basePath: manifest.config.basePath,
        i18n: manifest.config.i18n as NonNullable<
          SandboxRunParams['request']['nextConfig']
        >['i18n'],
        trailingSlash: manifest.config.trailingSlash,
      },
      url: url.href,
      page: {
        name: edgeFunction.page,
        ...(routeParams && { params: routeParams }),
      },
      body,
      signal: request.signal,
      waitUntil: requestContext.trackBackgroundWork,
    },
    useCache: true,
    onError: (error) => {
      console.error('edge runtime output error', error)
    },
    onWarning: (warning) => {
      console.warn('edge runtime output warning', warning)
    },
    clientAssetToken: '',
  })

  requestContext.trackBackgroundWork(result.waitUntil)

  return result.response
}
