// L6: runs one output's entrypoint for one request (Next's node handler, or an edge-runtime output
// in the sandbox), see docs/request-layers.md.
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { RequestMeta } from 'next-with-adapters/dist/server/request-meta.js'

import { PLUGIN_DIR } from '../../constants.js'
import { toComputeResponse, toReqRes } from '../../fetch-api-to-req-res.js'
import { invokeEdgeRuntimeOutput } from '../edge-runtime-sandbox.js'
import { getLogger } from '../request-context.cjs'
import { withActiveSpan } from '../tracer.cjs'

import { type InvokeHandlerArg, manifest } from './manifest.js'
import type { InvokeOptions, Produced, ProduceRequest } from './types.js'

/**
 * What invocation calls back into in the layers above it: Next's mid-render callbacks and the 500
 * page for a render that failed before its headers. The entry sets them at startup; importing them
 * here would be circular.
 * TODO(adapter): code smell, a module-level singleton set as a startup side effect. render404 and
 * revalidate belong to the request (closures carried in ProduceRequest), and a failure before headers
 * could come back as a Produced for dispatch to turn into the 500 page.
 */
type InvokeCallbacks = {
  render404: NonNullable<RequestMeta['render404']>
  revalidate: NonNullable<RequestMeta['revalidate']>
  renderErrorPage: (status: 500, request: Omit<ProduceRequest, 'resolution'>) => Promise<Produced>
}
let callbacks: InvokeCallbacks | undefined
export function configureInvoke(value: InvokeCallbacks) {
  callbacks = value
}
function getCallbacks(): InvokeCallbacks {
  if (!callbacks) {
    throw new Error('configureInvoke was not called')
  }
  return callbacks
}

type NodeHandlerFn = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx?: { waitUntil?: (prom: Promise<void>) => void; requestMeta?: RequestMeta },
) => Promise<void>

// Netlify Adapter machinery (just for integration tests resetting global state in-between tests)
// TODO(adapter): figure out something better, we should not expose test-only globals in the actual adapter code
const NetlifyAdapterTestReset = Symbol.for('@netlify/adapter-test-reset')

// Cache loaded handler functions
const nodeHandlerCache = new Map<string, NodeHandlerFn>()

const extendedGlobalThis = globalThis as typeof globalThis & {
  // just for reset in-between tests, see tests/utils/fixture.ts
  [NetlifyAdapterTestReset]: () => void
}

extendedGlobalThis[NetlifyAdapterTestReset] = () => {
  nodeHandlerCache.clear()
}

function preferDefault(mod: unknown): unknown {
  return mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod
}

// PLUGIN_DIR is the app dir inside the handler (where `.netlify` lives), output filePaths are relative
// to the handler root
const handlerRootDir = resolvePath(
  PLUGIN_DIR,
  ...manifest.relativeAppDir
    .split('/')
    .filter(Boolean)
    .map(() => '..'),
)

async function loadHandler(filePath: string): Promise<NodeHandlerFn> {
  const resolvedPath = pathToFileURL(resolvePath(handlerRootDir, filePath)).href
  const cached = nodeHandlerCache.get(resolvedPath)
  if (cached) {
    return cached
  }
  // eslint-disable-next-line import/no-dynamic-require
  const mod = await import(resolvedPath)
  const { handler } = (await preferDefault(mod)) as { handler: NodeHandlerFn }
  nodeHandlerCache.set(resolvedPath, handler)
  return handler
}

export async function invokeHandler(
  { id, entrypoint, runtime, sourcePage }: InvokeHandlerArg,
  { tracer, request, requestContext, resolution, span, invokeStatus }: ProduceRequest,
  { invocationId, raw, resume, postponed, onCacheEntry }: InvokeOptions = {},
): Promise<Produced> {
  span?.setAttribute('matched.sourcePage', sourcePage)
  span?.setAttribute('matched.runtime', runtime)
  return await withActiveSpan(tracer, 'invoke route handler', async (invokeSpan) => {
    if (runtime === 'edge') {
      try {
        const response = await invokeEdgeRuntimeOutput({
          outputId: id,
          request,
          requestContext,
          manifest,
          query: resolution.resolvedQuery,
          routeParams: resolution.invocation?.requestMeta.params,
          // only `initURL`: the rest of what node outputs get (`query`, `params`) is folded into the
          // URL the sandbox invokes with, and as request meta it'd end up in `resolvedUrl` too
          requestMeta: { initURL: resolution.invocation?.requestMeta.initURL ?? request.url },
        })
        return { kind: 'final' as const, response }
      } catch (error) {
        console.error('edge runtime output error', error)
        getLogger().withError(error).error('edge runtime output error')
        invokeSpan?.setAttribute('http.status_code', 500)
        return {
          kind: 'final' as const,
          response: new Response('Internal Server Error', { status: 500 }),
        }
      }
    }

    try {
      const handler = await loadHandler(entrypoint)

      // `@next/routing` says how to invoke the matched output (`req.url`, request meta), quirks
      // included; error pages are invoked without a resolution
      const { invocation } = resolution
      const handlerRequest = invocation
        ? new Request(new URL(invocation.url, request.url), request)
        : request
      // without one Next's minimal-mode response cache reuses renders across requests for 10s
      handlerRequest.headers.set('x-invocation-id', invocationId ?? randomUUID())
      for (const [key, value] of Object.entries(resume?.headers ?? {})) {
        handlerRequest.headers.set(key, value)
      }

      // Convert Web Request to Node.js IncomingMessage/ServerResponse
      const { req, res } = toReqRes(handlerRequest)
      if (invokeStatus) {
        res.statusCode = invokeStatus
      }

      // Invoke the route handler using the Node.js handler signature
      // as defined by the Next.js adapter contract:
      // handler(req: IncomingMessage, res: ServerResponse, ctx)
      const nextHandlerPromise = handler(req, res, {
        waitUntil: requestContext.trackBackgroundWork,
        requestMeta: {
          ...(invocation?.requestMeta ?? { initURL: request.url }),
          render404: getCallbacks().render404,
          revalidate: getCallbacks().revalidate,
          minimalMode: true,
          ...((resume ?? postponed) && { postponed: resume?.postponed ?? postponed }),
          ...(onCacheEntry && {
            onCacheEntryV2: async (entry: Parameters<typeof onCacheEntry>[0]) => {
              onCacheEntry(entry)
              return false
            },
          }),
        },
      })

      // Route modules rethrow render errors for the host to serve the error page (Next's router
      // renders /500 then). Ending the response here also avoids leaving it open until timeout.
      let failedBeforeHeaders = false
      nextHandlerPromise.catch((error) => {
        console.error('route handler error', error)
        if (!res.headersSent) {
          failedBeforeHeaders = true
          res.statusCode = 500
          res.end('Internal Server Error')
        }
      })

      // below is for now copied from standalone handler (without some extras, that generally could also be removed from standalone)
      // but will be nice to extract common handling to shared module and cleanup some things

      // Contrary to the docs, this resolves when the headers are available, not when the stream closes.
      // See https://github.com/fastly/http-compute-js/blob/main/src/http-compute-js/http-server.ts#L168-L173
      const response = await toComputeResponse(res)

      if (failedBeforeHeaders && !invokeStatus) {
        invokeSpan?.setAttribute('http.status_code', 500)
        return getCallbacks().renderErrorPage(500, { request, requestContext, tracer, span })
      }

      invokeSpan?.setAttribute('http.status_code', response.status)

      if (raw) {
        // not the background work: a regeneration running as background work reads this body
        const untilRendered = new TransformStream({
          async flush() {
            await nextHandlerPromise.catch(() => {
              // reported where the handler promise is created
            })
            res.emit('close')
          },
        })
        return {
          kind: 'final' as const,
          response: new Response(response.body?.pipeThrough(untilRendered), response),
        }
      }

      // eslint-disable-next-line no-inner-declarations
      async function waitForBackgroundWork() {
        // it's important to keep the stream open until the next handler has finished
        await nextHandlerPromise.catch(() => {
          // already reported above
        })

        // Next.js relies on `close` event emitted by response to trigger running callback variant of `next/after`
        // however @fastly/http-compute-js never actually emits that event - so we have to emit it ourselves,
        // otherwise Next would never run the callback variant of `next/after`
        res.emit('close')

        // We have to keep response stream open until tracked background promises that are don't use `context.waitUntil`
        // are resolved. If `context.waitUntil` is available, `requestContext.backgroundWorkPromise` will be empty
        // resolved promised and so awaiting it is no-op
        await requestContext.backgroundWorkPromise
      }

      const keepOpenUntilNextFullyRendered = new TransformStream({
        async flush() {
          await waitForBackgroundWork()
        },
      })

      if (!response.body) {
        await waitForBackgroundWork()
      }

      return {
        kind: 'next' as const,
        response: new Response(
          response.body?.pipeThrough(keepOpenUntilNextFullyRendered),
          response,
        ),
      }
    } catch (error) {
      console.error('route handler error', error)
      getLogger().withError(error).error('route handler error')
      invokeSpan?.setAttribute('http.status_code', 500)
      return {
        kind: 'final' as const,
        response: new Response('Internal Server Error', { status: 500 }),
      }
    }
  })
}
