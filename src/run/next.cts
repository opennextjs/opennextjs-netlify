import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import type { Span } from '@netlify/otel/opentelemetry'
// @ts-expect-error no types installed
import { patchFs } from 'fs-monkey'

import { HtmlBlob } from '../shared/blob-types.cjs'

import type { NextConfigForMultipleVersions } from './config.js'
import { getRequestContext } from './handlers/request-context.cjs'
import { getTracer, recordWarning, withActiveSpan } from './handlers/tracer.cjs'
import { getMemoizedKeyValueStoreBackedByRegionalBlobStore } from './storage/storage.cjs'

// https://github.com/vercel/next.js/pull/68193/files#diff-37243d614f1f5d3f7ea50bbf2af263f6b1a9a4f70e84427977781e07b02f57f1R49
// This import resulted in importing unbundled React which depending if NODE_ENV is `production` or not would use
// either development or production version of React. When not set to `production` it would use development version
// which later cause mismatching problems when both development and production versions of React were loaded causing
// react errors.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore ignoring readonly NODE_ENV
process.env.NODE_ENV = 'production'

// Prevent duplicate fetch spans by silencing fetch spans produced by Next.js
process.env.NEXT_OTEL_FETCH_DISABLED = '1'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getRequestHandlers } = require('next/dist/server/lib/start-server.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ResponseCache = require('next/dist/server/response-cache/index.js').default

// Next.js standalone doesn't expose background work promises (such as generating fresh response
// while stale one is being served) that we could use so we regrettably have to use hacks to
// gain access to them so that we can explicitly track them to ensure they finish before function
// execution stops
const originalGet = ResponseCache.prototype.get
ResponseCache.prototype.get = function get(...getArgs: unknown[]) {
  if (!this.didAddBackgroundWorkTracking) {
    if (typeof this.batcher !== 'undefined') {
      const originalBatcherBatch = this.batcher.batch
      this.batcher.batch = async (key: string, fn: (...args: unknown[]) => unknown) => {
        const trackedFn = async (...workFnArgs: unknown[]) => {
          const workPromise = fn(...workFnArgs)
          const requestContext = getRequestContext()
          if (requestContext && workPromise instanceof Promise) {
            requestContext.trackBackgroundWork(workPromise)
          }
          return await workPromise
        }

        return originalBatcherBatch.call(this.batcher, key, trackedFn)
      }
    } else if (typeof this.pendingResponses !== 'undefined') {
      const backgroundWork = new Map<string, () => void>()

      const originalPendingResponsesSet = this.pendingResponses.set
      this.pendingResponses.set = async (key: string, value: unknown) => {
        const requestContext = getRequestContext()
        if (requestContext && !this.pendingResponses.has(key)) {
          const workPromise = new Promise<void>((_resolve) => {
            backgroundWork.set(key, _resolve)
          })

          requestContext.trackBackgroundWork(workPromise)
        }
        return originalPendingResponsesSet.call(this.pendingResponses, key, value)
      }

      const originalPendingResponsesDelete = this.pendingResponses.delete
      this.pendingResponses.delete = async (key: string) => {
        const _resolve = backgroundWork.get(key)
        if (_resolve) {
          _resolve()
        }
        return originalPendingResponsesDelete.call(this.pendingResponses, key)
      }
    }

    this.didAddBackgroundWorkTracking = true
  }
  return originalGet.apply(this, getArgs)
}

type FS = typeof import('fs')

export async function getMockedRequestHandler(
  nextConfig: NextConfigForMultipleVersions,
  ...args: Parameters<typeof getRequestHandlers>
) {
  const initContext = { initializingServer: true }
  /**
   * Using async local storage to identify operations happening as part of server initialization
   * and not part of handling of current request.
   */
  const initAsyncLocalStorage = new AsyncLocalStorage<typeof initContext>()

  return withActiveSpan(getTracer(), 'mocked request handler', async () => {
    const ofs = { ...fs }

    async function readFileFallbackBlobStore(...fsargs: Parameters<FS['promises']['readFile']>) {
      const [path, options] = fsargs
      try {
        // Attempt to read from the disk
        // important to use the `import * as fs from 'fs'` here to not end up in a endless loop
        return await ofs.readFile(path, options)
      } catch (error) {
        // only try to get .html files from the blob store
        if (typeof path === 'string' && path.endsWith('.html')) {
          const cacheStore = getMemoizedKeyValueStoreBackedByRegionalBlobStore()
          const relPath = relative(resolve(nextConfig.distDir, 'server/pages'), path)
          const file = await cacheStore.get<HtmlBlob>(relPath, 'staticHtml.get')
          if (file !== null) {
            if (file.isFullyStaticPage) {
              const requestContext = getRequestContext()
              // On server initialization Next.js attempt to preload all pages
              // which might result in reading .html files from the file system
              // for fully static pages. We don't want to capture those cases.
              // Note that Next.js does NOT cache read html files so on actual requests
              // that those will be served, it will read those AGAIN and then we do
              // want to capture fact of reading them.
              const { initializingServer } = initAsyncLocalStorage.getStore() ?? {}
              if (!initializingServer && requestContext) {
                requestContext.usedFsReadForNonFallback = true
              }
            }

            return file.html
          }
        }

        throw error
      }
    }

    // patch the file system for fs.promises with operations to fallback on the blob store
    patchFs(
      {
        readFile: readFileFallbackBlobStore,
      },
      // eslint-disable-next-line n/global-require, @typescript-eslint/no-var-requires
      require('fs').promises,
    )

    const requestHandlers = await initAsyncLocalStorage.run(initContext, async () => {
      // we need to await getRequestHandlers(...) promise in this callback to ensure that initAsyncLocalStorage
      // is available in async / background work
      return await getRequestHandlers(...args)
    })

    // depending on Next.js version requestHandlers might be an array of object
    // see https://github.com/vercel/next.js/commit/08e7410f15706379994b54c3195d674909a8d533#diff-37243d614f1f5d3f7ea50bbf2af263f6b1a9a4f70e84427977781e07b02f57f1R742
    return Array.isArray(requestHandlers) ? requestHandlers[0] : requestHandlers.requestHandler
  })
}

let cacheComponentsTracerPatchState: 'pending' | 'patched' | 'unavailable' = 'pending'

/**
 * Next.js only installs its Cache Components tracer patch when the application itself has an
 * `instrumentation.ts` exporting `register` - `afterRegistration()` is called from there and
 * nowhere else:
 * https://github.com/vercel/next.js/blob/9480f7f9ffdc271014d959e7b10d681882eaabb5/packages/next/src/server/lib/router-utils/instrumentation-globals.external.ts#L56-L59
 *
 * Our Functions bootstrap registers an OpenTelemetry SDK outside that hook, so on sites with no
 * `instrumentation.ts` the tracer is left unpatched. An unpatched tracer generates span ids with
 * OpenTelemetry's `RandomIdGenerator`, which uses `Math.random()`:
 * https://github.com/open-telemetry/opentelemetry-js/blob/76fa6b509e2b48d9cbee31cb37a2efc61dc4d384/packages/sdk-trace/src/platform/node/RandomIdGenerator.ts#L31
 *
 * With `cacheComponents` enabled Next patches `Math.random` to count as synchronous platform IO,
 * which aborts the surrounding prerender:
 * https://github.com/vercel/next.js/blob/9480f7f9ffdc271014d959e7b10d681882eaabb5/packages/next/src/server/node-environment-extensions/random.tsx#L14-L15
 *
 * The failure is silent - the runtime-prefetch payload that seeds the client segment cache is
 * dropped from the initial HTML, so navigations refetch content that should already have been
 * seeded.
 *
 * Calling `afterRegistration()` ourselves fixes it. It patches whichever provider is registered
 * on `@opentelemetry/api`, resolving that package from the app and falling back to Next's own
 * bundled copy:
 * https://github.com/vercel/next.js/blob/9480f7f9ffdc271014d959e7b10d681882eaabb5/packages/next/src/server/lib/router-utils/instrumentation-node-extensions.ts#L52-L59
 *
 * That fallback is what makes this work for us. We bundle `@opentelemetry/api` into the
 * bootstrap, so the app cannot resolve one and Next uses its compiled copy - yet both reach the
 * same `ProxyTracerProvider`, because the API keeps its global registration on `globalThis`
 * under `Symbol.for('opentelemetry.js.api.<major>')`, shared by every copy of the package on the
 * same major version:
 * https://github.com/open-telemetry/opentelemetry-js/blob/76fa6b509e2b48d9cbee31cb37a2efc61dc4d384/api/src/internal/global-utils.ts#L15
 *
 * It has to run from a request though: after Next's `node-environment` is loaded (it pulls in
 * `work-unit-async-storage-instance`, which throws if `AsyncLocalStorage` isn't set up yet) and
 * after the SDK has registered, which the bootstrap only does once a traced request arrives. On
 * a warm lambda that can be many requests in, hence the repeated check rather than a one-shot
 * call at startup.
 *
 * Remove once Next.js calls `afterRegistration()` unconditionally.
 */
export function ensureOtelTracerPatchedForCacheComponents(span?: Span) {
  if (cacheComponentsTracerPatchState !== 'pending') {
    return
  }

  // Only returns a tracer once a provider is registered, so this is the signal that there
  // is something to patch.
  if (!getTracer()) {
    return
  }

  try {
    // Runtime lookup: the module only exists in Next.js versions that ship Cache Components.
    const extensionsPath = 'next/dist/server/lib/router-utils/instrumentation-node-extensions.js'
    // eslint-disable-next-line n/global-require, @typescript-eslint/no-var-requires, import/no-dynamic-require
    const { afterRegistration } = require(extensionsPath)
    afterRegistration()
    cacheComponentsTracerPatchState = 'patched'
  } catch (error) {
    cacheComponentsTracerPatchState = 'unavailable'

    // A missing module just means a Next.js version predating the extension - nothing to
    // patch, nothing worth reporting. Anything else is unexpected.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'MODULE_NOT_FOUND') {
      recordWarning(
        new Error('Failed to patch OpenTelemetry tracer for Cache Components', { cause: error }),
        span,
      )
    }
  }
}
