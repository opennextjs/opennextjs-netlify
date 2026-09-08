// @ts-check

// this is not TS file because it's used both directly inside test process
// as well as child process that lacks TS on-the-fly transpilation

import { join } from 'node:path'
import { BLOB_TOKEN } from './constants.mjs'
import { execute as untypedExecute } from 'lambda-local'

const SERVER_HANDLER_NAME = '___netlify-server-handler'

/**
 * @typedef {import('./contexts').FixtureTestContext} FixtureTestContext
 *
 * @typedef {Awaited<ReturnType<ReturnType<typeof import('@netlify/serverless-functions-api').getLambdaHandler>>>} LambdaResult
 *
 * @typedef {Object} FunctionInvocationOptions
 * @property {Record<string, string>} [env] Environment variables that should be set during the invocation
 * @property {string} [httpMethod] The http method that is used for the invocation. Defaults to 'GET'
 * @property {string} [url] TThe relative path that should be requested. Defaults to '/'
 * @property {Record<string, string>} [headers] The headers used for the invocation
 * @property {Record<string, unknown>} [flags] Feature flags that should be set during the invocation
 *
 * @typedef {Pick<FunctionInvocationOptions, 'env'>} LoadFunctionOptions
 */

/**
 * This is helper to get LambdaLocal's execute to actually provide result type instead of `unknown`
 * Because jsdoc doesn't seem to have equivalent of `as` in TS and trying to assign `LambdaResult` type
 * to return value of `execute` leading to `Type 'unknown' is not assignable to type 'LambdaResult'`
 * error, this types it as `any` instead which allow to later type it as `LambdaResult`.
 * @param  {Parameters<typeof untypedExecute>} args
 * @returns {Promise<LambdaResult>}
 */
async function execute(...args) {
  /**
   * @type {any}
   */
  const anyResult = await untypedExecute(...args)

  return anyResult
}

/**
 * @param {FixtureTestContext} ctx
 */
export const createBlobContext = (ctx) =>
  Buffer.from(
    JSON.stringify({
      edgeURL: `http://${ctx.blobStoreHost}`,
      uncachedEdgeURL: `http://${ctx.blobStoreHost}`,
      token: BLOB_TOKEN,
      siteID: ctx.siteID,
      deployID: ctx.deployID,
      primaryRegion: 'us-test-1',
    }),
  ).toString('base64')

/**
 * Converts a readable stream to a buffer
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<Buffer>}
 */
function streamToBuffer(stream) {
  /**
   * @type {Buffer[]}
   */
  const chunks = []

  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('error', (err) => reject(err))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/**
 * @param {FixtureTestContext} ctx
 * @param {Record<string, string>} [env]
 */
function temporarilySetEnv(ctx, env) {
  const environment = {
    NODE_ENV: 'production',
    NETLIFY_BLOBS_CONTEXT: createBlobContext(ctx),
    ...(env || {}),
  }

  const envVarsToRestore = {}

  // We are not using lambda-local's environment variable setting because it cleans up
  // environment vars to early (before stream is closed)
  Object.keys(environment).forEach(function (key) {
    if (typeof process.env[key] !== 'undefined') {
      envVarsToRestore[key] = process.env[key]
    }
    process.env[key] = environment[key]
  })

  return function restoreEnvironment() {
    Object.keys(environment).forEach(function (key) {
      if (typeof envVarsToRestore[key] !== 'undefined') {
        process.env[key] = envVarsToRestore[key]
      } else {
        delete process.env[key]
      }
    })
  }
}

const DEFAULT_FLAGS = {}

/**
 * @param {FixtureTestContext} ctx
 * @param {LoadFunctionOptions} options
 */
export async function loadFunction(ctx, { env } = {}) {
  const restoreEnvironment = temporarilySetEnv(ctx, env)

  const { handler } = await import(
    'file:///' + join(ctx.functionDist, SERVER_HANDLER_NAME, '___netlify-entry-point.mjs')
  )

  /**
   * @param {FunctionInvocationOptions} options
   */
  async function invokeFunction({ headers, httpMethod, flags, url, env: invokeEnv } = {}) {
    const restoreEnvironment = temporarilySetEnv(ctx, {
      ...env,
      ...invokeEnv,
    })

    let resolveInvocation, rejectInvocation
    const invocationPromise = new Promise((resolve, reject) => {
      resolveInvocation = resolve
      rejectInvocation = reject
    })

    const response = await execute({
      event: {
        headers: headers || {},
        httpMethod: httpMethod || 'GET',
        rawUrl: new URL(url || '/', 'https://example.netlify').href,
        flags: flags ?? DEFAULT_FLAGS,
      },
      lambdaFunc: { handler },
      // TODO(adapter): get back to it, in CI it seems like it times out - but for now let's test for correctness first and the check timeouts
      timeoutMs: 50_000,
      onInvocationEnd: (error) => {
        // lambda-local resolve promise return from execute when response is closed
        // but we should wait for tracked background work to finish
        // before resolving the promise to allow background work to finish
        if (error) {
          rejectInvocation(error)
        } else {
          resolveInvocation()
        }
      },
    })

    await invocationPromise

    if (!response) {
      throw new Error('No response from lambda-local')
    }

    const responseHeaders = Object.entries(response.multiValueHeaders || {}).reduce(
      (prev, [key, value]) => ({
        ...prev,
        [key]: value.length === 1 ? `${value}` : value.join(', '),
      }),
      response.headers || {},
    )

    const bodyBuffer = await streamToBuffer(response.body)

    restoreEnvironment()

    return {
      statusCode: response.statusCode,
      bodyBuffer,
      body: bodyBuffer.toString('utf-8'),
      headers: responseHeaders,
      isBase64Encoded: response.isBase64Encoded,
    }
  }

  restoreEnvironment()

  return invokeFunction
}

/**
 * @typedef {Awaited<ReturnType<typeof loadFunction>>} InvokeFunction
 * @typedef {Promise<Awaited<ReturnType<InvokeFunction>>>} InvokeFunctionResult
 */
