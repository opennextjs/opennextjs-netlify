import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs/promises'
import { relative, resolve } from 'node:path'

// @ts-expect-error no types installed
import { patchFs } from 'fs-monkey'

import { HtmlBlob } from '../shared/blob-types.cjs'

import type { NextConfigForMultipleVersions } from './config.js'
import { getRequestContext } from './handlers/request-context.cjs'
import { getTracer, withActiveSpan } from './handlers/tracer.cjs'
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
