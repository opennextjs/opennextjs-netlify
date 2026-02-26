import { assert, vi } from 'vitest'

import { type NetlifyPluginConstants, type NetlifyPluginOptions } from '@netlify/build'
import { resolveConfig as resolveNetlifyConfig } from '@netlify/config'
import { bundle, serve } from '@netlify/edge-bundler'
import { getURL as getBootstrapURL } from '@netlify/edge-functions-bootstrap/version'
import { zipFunctions } from '@netlify/zip-it-and-ship-it'
import { execaCommand } from 'execa'
import getPort from 'get-port'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, parse, relative } from 'node:path'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { v4 } from 'uuid'
import { LocalServer } from './local-server.js'
import {
  type InvokeFunctionResult,
  loadFunction,
  type LoadFunctionOptions,
  type FunctionInvocationOptions,
} from './lambda-helpers.mjs'

import { glob } from 'fast-glob'
import {
  EDGE_HANDLER_NAME,
  PluginContext,
  SERVER_HANDLER_NAME,
} from '../../src/build/plugin-context.js'
import { BLOB_TOKEN } from './constants.mjs'
import { type FixtureTestContext } from './contexts.js'
import { hasDefaultTurbopackBuilds, setNextVersionInFixture } from './next-version-helpers.mjs'

const bootstrapURL = await getBootstrapURL()
const actualCwd = await vi.importActual<typeof import('process')>('process').then((p) => p.cwd())
const eszipHelper = join(actualCwd, 'tools/deno/eszip.ts')

const require = createRequire(import.meta.url)
const mod = require('module')

const originalRequire = mod.prototype.require
const originalResolveFilename = mod._resolveFilename

async function installDependencies(cwd: string) {
  const NEXT_VERSION = process.env.NEXT_VERSION ?? 'latest'
  await setNextVersionInFixture(cwd, NEXT_VERSION, { silent: true })

  const { packageManager } = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
  if (packageManager?.startsWith('pnpm')) {
    await execaCommand(`pnpm install --ignore-scripts --reporter=silent`, {
      cwd,
    })
  } else {
    await execaCommand(
      `npm install --ignore-scripts --no-audit --progress=false --legacy-peer-deps`,
      { cwd },
    )
  }

  if (process.env.DEBUG) {
    await execaCommand(packageManager?.startsWith('pnpm') ? `pnpm list next` : 'npm list next', {
      cwd,
      stdio: 'inherit',
      reject: false,
    })
  }
}

export const getFixtureSourceDirectory = (fixture: string) =>
  fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url))

// https://github.com/vercel/next.js/pull/67539 added more imports to "globals" modules which does have a side effect at import time
// that defines NOT configurable global property ( https://github.com/vercel/next.js/blob/ba3959bb46f4d0e92403304579b8fb30d3ecc3d1/packages/next/src/server/web/globals.ts#L87-L107 ).
// Running multiple fixtures in the same process then would evaluate copy of that module
// and attempt to redefine that not configurable property which result in an error. We can't delete that property either, so
// this "patch" to Object.defineProperty is making that property configurable when running our tests to avoid that error.
const originalDefineProperty = Object.defineProperty
Object.defineProperty = function (target, property, descriptor) {
  if (property === '__import_unsupported' && descriptor?.configurable === false) {
    descriptor.configurable = true
  }

  return originalDefineProperty.call(this, target, property, descriptor)
}

/**
 * Copies a fixture to a temp folder on the system and runs the tests inside.
 * @param fixture name of the folder inside the fixtures folder
 */
export const createFixture = async (fixture: string, ctx: FixtureTestContext) => {
  // if we did run lambda from other fixture before it will set some global flags
  // that would prevent Next.js from patching it again meaning that future function
  // invocations would not use fetch-cache at all - this restores the original fetch
  // and makes globalThis.fetch.__nextPatched falsy which will allow Next.js to apply
  // needed patch
  if (
    // @ts-ignore fetch doesn't have __nextPatched property in types
    globalThis.fetch.__nextPatched &&
    // before https://github.com/vercel/next.js/pull/64088 original fetch was set on globalThis._nextOriginalFetch
    // after it it is being set on globalThis.fetch._nextOriginalFetch
    // so we check both to make sure tests continue to work regardless of next version
    // @ts-ignore fetch doesn't have _nextOriginalFetch property in types
    (globalThis._nextOriginalFetch || globalThis.fetch._nextOriginalFetch)
  ) {
    // @ts-ignore fetch doesn't have _nextOriginalFetch property in types
    globalThis.fetch = globalThis._nextOriginalFetch || globalThis.fetch._nextOriginalFetch
    // https://github.com/vercel/next.js/pull/68193/files#diff-4c54e369ddb9a2db1eed95fe1d678f94c8e82c540204475d42c78e49bf4f223aR37-R40
    // above changed the way Next.js checks wether fetch was already patched. It still sets `__nextPatched` and `_nextOriginalFetch`
    // properties we check above and use to get original fetch back
    delete globalThis[Symbol.for('next-patch')]
  }

  // due to changes in https://github.com/vercel/next.js/pull/86591 , this global is specific to instance of application and we to clean it up
  // from any previous function invocations that might have run in the same process
  delete globalThis[Symbol.for('next.server.manifests')]

  // Netlify Adapter used Next.js inner machinery
  delete globalThis[Symbol.for('@next/router-server-methods')]

  // Netlify Adapter specific global to reset between tests
  if (globalThis[Symbol.for('@netlify/adapter-test-reset')]) {
    globalThis[Symbol.for('@netlify/adapter-test-reset')]()
  }

  // require hook leaves modified "require" and "require.resolve" modified - we restore here to original
  // https://github.com/vercel/next.js/blob/812c26ab8741f68fbd6e2fe095510e0f03eac4c5/packages/next/src/server/require-hook.ts
  mod.prototype.require = originalRequire
  mod._resolveFilename = originalResolveFilename

  // node environment baseline defines global WebSocket getter that requires compiled 'ws' package from first function modules
  // we need to reset the getter to not have it attempt to import 'ws' package from unrelated functions that might have already been deleted
  // https://github.com/vercel/next.js/blob/812c26ab8741f68fbd6e2fe095510e0f03eac4c5/packages/next/src/server/node-environment-baseline.ts#L11-L27
  // note that some next versions didn't have setter, so we can't just do "globalThis.WebSocket = undefined" as that would throw
  // "Cannot set property WebSocket of #<Object> which has only a getter" errors
  Object.defineProperty(globalThis, 'WebSocket', {
    get() {
      return undefined
    },
    set(value) {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value,
      })
    },
    configurable: true,
  })

  ctx.cwd = await mkdtemp(join(tmpdir(), 'opennextjs-netlify-'))
  vi.spyOn(process, 'cwd').mockReturnValue(ctx.cwd)

  ctx.cleanup = []

  // Path to a temporary file that receives the stderr and stdout of the edge
  // functions server. This lets us capture logs reliably, which isn't the
  // case if we pipe them to the parent process (the test runner).
  const edgeFunctionsLogsPath = join(ctx.cwd, 'edge-functions-output.netlify')

  ctx.edgeFunctionOutput = createWriteStream(edgeFunctionsLogsPath, {
    flags: 'a',
  })

  if (env.INTEGRATION_PERSIST) {
    console.log(
      `💾 Fixture '${fixture}' has been persisted at '${ctx.cwd}'. To clean up automatically, run tests without the 'INTEGRATION_PERSIST' environment variable.`,
    )

    ctx.cleanup.push(async () => {
      try {
        const logOutput = await readFile(edgeFunctionsLogsPath, 'utf8')

        if (!logOutput.trim()) {
          return
        }

        console.log(logOutput)
      } catch {}
    })
  } else {
    ctx.cleanup.push(async () => {
      try {
        await rm(ctx.cwd, { recursive: true, force: true })
      } catch (error) {
        console.log(`Fixture '${fixture}' has failed to cleanup at '${ctx.cwd}'`, error)
      }
      if (ctx.functionDist) {
        try {
          await rm(ctx.functionDist, { recursive: true, force: true })
        } catch (error) {
          console.log(
            `Fixture's '${fixture}' bundled serverless function has failed to cleanup at '${ctx.cwd}'`,
            error,
          )
        }
      }
    })
  }

  try {
    const src = getFixtureSourceDirectory(fixture)
    const files = await glob('**/*', {
      cwd: src,
      dot: true,
      ignore: ['node_modules'],
    })

    await Promise.all(
      files.map((file) => cp(join(src, file), join(ctx.cwd, file), { recursive: true })),
    )

    await installDependencies(ctx.cwd)
  } catch (error) {
    throw new Error(`could not prepare the fixture: ${fixture}. ${error}`)
  }

  return { cwd: ctx.cwd }
}

export const createFsFixture = async (fixture: Record<string, string>, ctx: FixtureTestContext) => {
  ctx.cwd = await mkdtemp(join(tmpdir(), 'opennextjs-netlify-'))
  vi.spyOn(process, 'cwd').mockReturnValue(ctx.cwd)
  ctx.cleanup = [
    async () => {
      try {
        await rm(ctx.cwd, { recursive: true, force: true })
      } catch {
        // noop
      }
    },
  ]

  try {
    await Promise.all(
      Object.entries(fixture).map(async ([key, value]) => {
        const filepath = join(ctx.cwd, key)
        await mkdir(dirname(filepath), { recursive: true })
        await writeFile(filepath, value, 'utf-8')
      }),
    )
  } catch (error) {
    throw new Error(`could not prepare the fixture from json ${error}`)
  }

  return { cwd: ctx.cwd }
}

export async function runPluginStep(
  ctx: FixtureTestContext,
  step: 'onPreBuild' | 'onBuild' | 'onPostBuild' | 'onEnd',
  constants: Partial<NetlifyPluginConstants> = {},
) {
  // `invokeFunction` also does cwd mocking (to function directory in that case),
  // so in case `runPluginStep` is executed after `invokeFunction`,
  // we ensure the cwd is set to fixture root again
  vi.spyOn(process, 'cwd').mockReturnValue(ctx.cwd)

  const stepFunction = (await import('../../src/index.js'))[step]

  let netlifyConfig = {
    headers: [],
    redirects: [],
  }

  // load netlify.toml if it exists
  if (existsSync(join(ctx.cwd, 'netlify.toml'))) {
    const resolvedNetlifyConfig = await resolveNetlifyConfig({ cwd: ctx.cwd })
    if (resolvedNetlifyConfig.config) {
      netlifyConfig = resolvedNetlifyConfig.config
    }
  }

  const options = {
    constants: {
      SITE_ID: ctx.siteID,
      NETLIFY_API_TOKEN: BLOB_TOKEN,
      NETLIFY_API_HOST: ctx.blobStoreHost,
      PUBLISH_DIR: join(constants.PACKAGE_PATH || '', '.next'),
      ...(constants || {}),
      // TODO: figure out if we need them
      // CONFIG_PATH: 'netlify.toml',
      // FUNCTIONS_DIST: '.netlify/functions/',
      // EDGE_FUNCTIONS_DIST: '.netlify/edge-functions-dist/',
      // CACHE_DIR: '.netlify/cache',
      // IS_LOCAL: true,
      // NETLIFY_BUILD_VERSION: '29.23.4',
      // INTERNAL_FUNCTIONS_SRC: '.netlify/functions-internal',
      // INTERNAL_EDGE_FUNCTIONS_SRC: '.netlify/edge-functions',
    },
    netlifyConfig,
    utils: {
      build: {
        failBuild: (message, options: { error?: Error } = {}) => {
          if (options.error) console.error(options.error)
          assert.fail(`${message}: ${options?.error || ''}`)
        },
        failPlugin: (message, options: { error?: Error } = {}) => {
          if (options.error) console.error(options.error)
          assert.fail(`${message}: ${options?.error || ''}`)
        },
        cancelBuild: (message, options: { error?: Error } = {}) => {
          if (options.error) console.error(options.error)
          assert.fail(`${message}: ${options?.error || ''}`)
        },
      },
      cache: {
        save: vi.fn(),
        restore: vi.fn(),
      },
    },
  } as unknown as NetlifyPluginOptions
  await stepFunction(options)
  return options
}

/**
 * This method does basically two main parts
 * 1. Running the `onBuild` plugin with a set of defined constants
 * 2. Bundling the function up to an actual lambda function embedding the Netlify local parts
 * @param ctx The testing context
 * @param constants The build plugin constants that are passed down by `@netlify/build` to the plugin
 */
export async function runPlugin(
  ctx: FixtureTestContext,
  constants: Partial<NetlifyPluginConstants> = {},
) {
  // imitate netlify/build here
  constants.PUBLISH_DIR = constants.PUBLISH_DIR || join(constants.PACKAGE_PATH || '', '.next')
  const options = await runPluginStep(ctx, 'onBuild', constants)

  const base = new PluginContext(options)
  vi.spyOn(base, 'resolveFromPackagePath').mockImplementation((...args: string[]) =>
    join(ctx.cwd, options.constants.PACKAGE_PATH || '', ...args),
  )
  const internalSrcFolder = base.serverFunctionsDir

  const bundleFunctions = async () => {
    if (!existsSync(internalSrcFolder)) {
      return
    }
    // create zip location in a new temp folder to avoid leaking node_modules through nodes resolve algorithm
    // that always looks up a parent directory for node_modules
    ctx.functionDist = await mkdtemp(join(tmpdir(), 'opennextjs-netlify-dist'))
    // bundle the function to get the bootstrap layer and all the important parts
    await zipFunctions([internalSrcFolder], ctx.functionDist, {
      basePath: ctx.cwd,
      manifest: join(ctx.functionDist, 'manifest.json'),
      repositoryRoot: ctx.cwd,
      configFileDirectories: [internalSrcFolder],
      internalSrcFolder,
      archiveFormat: 'none',
    })
  }

  const bundleEdgeFunctions = async () => {
    const dist = base.resolveFromPackagePath('.netlify', 'edge-functions-bundled')
    const edgeSource = base.edgeFunctionsDir

    if (!existsSync(edgeSource)) {
      return
    }

    const result = await bundle([edgeSource], dist, [], {
      bootstrapURL,
      internalSrcFolder: edgeSource,
      importMapPaths: [],
      basePath: ctx.cwd,
      configPath: join(edgeSource, 'manifest.json'),
    })
    const { asset } = result.manifest.bundles[0]
    const cmd = `deno run --allow-read --allow-write --allow-net --allow-env ${eszipHelper} extract ./${asset} .`
    await execaCommand(cmd, { cwd: dist })

    // start the edge functions server:
    const servePath = base.resolveFromPackagePath('.netlify', 'edge-functions-serve')
    ctx.edgeFunctionPort = await getPort()
    const server = await serve({
      basePath: ctx.cwd,
      bootstrapURL,
      port: ctx.edgeFunctionPort,
      servePath: servePath,
      // debug: true,
      userLogger: console.log,
      stdout: ctx.edgeFunctionOutput,
      stderr: ctx.edgeFunctionOutput,
    })

    await server(
      result.functions.map((fn) => ({
        name: fn.name,
        path: join(dist, 'source/root', relative(ctx.cwd, fn.path)),
      })),
    )
  }

  await Promise.all([bundleEdgeFunctions(), bundleFunctions(), uploadBlobs(ctx, base.blobDir)])

  return options
}

export async function uploadBlobs(ctx: FixtureTestContext, blobsDir: string) {
  const files = await glob('**/*', {
    dot: true,
    cwd: blobsDir,
  })

  const keys = files.filter((file) => !basename(file).startsWith('$'))
  await Promise.all(
    keys.map(async (key) => {
      const { dir, base } = parse(key)
      const metaFile = join(blobsDir, dir, `$${base}.json`)
      const metadata = await readFile(metaFile, 'utf-8')
        .then((meta) => JSON.parse(meta))
        .catch(() => ({}))
      await ctx.blobStore.set(key, await readFile(join(blobsDir, key), 'utf-8'), { metadata })
    }),
  )
}

export async function invokeFunction(
  ctx: FixtureTestContext,
  options: FunctionInvocationOptions = {},
) {
  // now for the execution set the process working directory to the dist entry point
  const cwdMock = vi
    .spyOn(process, 'cwd')
    .mockReturnValue(join(ctx.functionDist, SERVER_HANDLER_NAME))
  try {
    const invokeFunctionImpl = await loadFunction(ctx, options)
    return await invokeFunctionImpl(options)
  } finally {
    cwdMock.mockRestore()
  }
}

export async function invokeEdgeFunction(
  ctx: FixtureTestContext,
  options: {
    /**
     * The local server to use as the mock origin
     */
    origin?: LocalServer

    /**
     * The relative path for the request
     * @default '/'
     */
    url?: string

    /**
     * Custom headers for the request
     */
    headers?: Record<string, string>

    /**
     * Whether to follow redirects
     */
    redirect?: RequestInit['redirect']

    /** Array of functions to invoke */
    functions?: string[]
  } = {},
): Promise<Response> {
  const passthroughHost = options.origin ? `localhost:${options.origin.port}` : ''
  const functionsToInvoke = options.functions || [EDGE_HANDLER_NAME]

  return await fetch(`http://0.0.0.0:${ctx.edgeFunctionPort}${options.url ?? '/'}`, {
    redirect: options.redirect,

    // Checkout the stargate headers: https://github.com/netlify/stargate/blob/dc8adfb6e91fa0a2fb00c0cba06e4e2f9e5d4e4d/proxy/deno/edge.go#L1142-L1170
    headers: {
      'x-nf-edge-functions': functionsToInvoke.join(','),
      'x-nf-deploy-id': ctx.deployID,
      'x-nf-site-info': Buffer.from(
        JSON.stringify({ id: ctx.siteID, name: 'Test Site', url: 'https://example.com' }),
      ).toString('base64'),
      'x-nf-blobs-info': Buffer.from(
        JSON.stringify({ url: `http://${ctx.blobStoreHost}`, token: BLOB_TOKEN }),
      ).toString('base64'),
      'x-nf-passthrough': 'passthrough',
      'x-nf-passthrough-host': passthroughHost,
      'x-nf-passthrough-proto': 'http:',
      'x-nf-request-id': v4(),
      ...options.headers,
    },
  })
}

/**
 * Load function in child process and allow for multiple invocations
 */
export async function loadSandboxedFunction(
  ctx: FixtureTestContext,
  options: LoadFunctionOptions = {},
) {
  const childProcess = spawn(process.execPath, [import.meta.dirname + '/sandbox-child.mjs'], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    cwd: join(ctx.functionDist, SERVER_HANDLER_NAME),
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  })

  let isRunning = true
  let operationCounter = 1

  childProcess.stdout?.on('data', (data) => {
    console.log(data.toString())
  })

  childProcess.stderr?.on('data', (data) => {
    console.error(data.toString())
  })

  const onGoingOperationsMap = new Map<
    number,
    {
      resolve: (value?: any) => void
      reject: (reason?: any) => void
    }
  >()

  function createOperation<T>() {
    const operationId = operationCounter
    operationCounter += 1

    let promiseResolve, promiseReject
    const promise = new Promise<T>((innerResolve, innerReject) => {
      promiseResolve = innerResolve
      promiseReject = innerReject
    })

    function resolve(value: T) {
      onGoingOperationsMap.delete(operationId)
      promiseResolve?.(value)
    }
    function reject(reason) {
      onGoingOperationsMap.delete(operationId)
      promiseReject?.(reason)
    }

    onGoingOperationsMap.set(operationId, { resolve, reject })
    return { operationId, promise, resolve, reject }
  }

  childProcess.on('exit', () => {
    isRunning = false

    const error = new Error('worker exited before returning result')

    for (const { reject } of onGoingOperationsMap.values()) {
      reject(error)
    }
  })

  function exit() {
    if (isRunning) {
      childProcess.send({ action: 'exit' })
    }
  }

  // make sure to exit the child process when the test is done just in case
  ctx.cleanup?.push(async () => exit())

  const { promise: loadPromise, resolve: loadResolve } = createOperation<void>()

  childProcess.on('message', (msg: any) => {
    if (msg?.action === 'invokeFunctionResult') {
      onGoingOperationsMap.get(msg.operationId)?.resolve(msg.result)
    } else if (msg?.action === 'loadedFunction') {
      loadResolve()
    }
  })

  // context object is not serializable so we create serializable object
  // containing required properties to invoke lambda
  const serializableCtx = {
    functionDist: ctx.functionDist,
    blobStoreHost: ctx.blobStoreHost,
    siteID: ctx.siteID,
    deployID: ctx.deployID,
  }

  childProcess.send({
    action: 'loadFunction',
    args: [serializableCtx],
  })

  await loadPromise

  function invokeFunction(options: FunctionInvocationOptions): InvokeFunctionResult {
    if (!isRunning) {
      throw new Error('worker is not running anymore')
    }

    const { operationId, promise } = createOperation<Awaited<InvokeFunctionResult>>()

    childProcess.send({
      action: 'invokeFunction',
      operationId,
      args: [serializableCtx, options],
    })

    return promise
  }

  return {
    invokeFunction,
    exit,
  }
}

/**
 * Load function in child process and execute single invocation
 */
export async function invokeSandboxedFunction(
  ctx: FixtureTestContext,
  options: FunctionInvocationOptions = {},
) {
  const { invokeFunction, exit } = await loadSandboxedFunction(ctx, options)
  const result = await invokeFunction(options)
  exit()
  return result
}

export const EDGE_MIDDLEWARE_FUNCTION_NAME = '___netlify-edge-handler-middleware'
// Turbopack has different output than webpack
export const EDGE_MIDDLEWARE_SRC_FUNCTION_NAME = hasDefaultTurbopackBuilds()
  ? EDGE_MIDDLEWARE_FUNCTION_NAME
  : '___netlify-edge-handler-src-middleware'
export const NODE_MIDDLEWARE_FUNCTION_NAME = '___netlify-edge-handler-node-middleware'
