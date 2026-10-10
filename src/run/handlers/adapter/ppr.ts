// L5: composes a stored PPR shell with a resumed render, see docs/request-layers.md.
import { Buffer } from 'node:buffer'

import {
  POSTPONED_LENGTH_HEADER,
  PPR_SHELL_HEADER,
} from '../../../../edge-runtime/lib/private-request-meta.ts'
import type { PrerenderGroupBlob } from '../../../shared/blob-types.cjs'
import { getLogger } from '../request-context.cjs'

import { finalize } from './finalize.js'
import { invokeHandler } from './invoke.js'
import { computeOutputsById, manifest, type PrerenderOutput } from './manifest.js'
import type { Produced, ProduceRequest, StoredCache } from './types.js'

/**
 * PPR: the stored shell is only the start of the page, the rest comes from resuming its postponed
 * render, streamed after it as one response (and a dynamic RSC request is a resume on its own). The
 * result is per request, so it isn't cached.
 */
export async function resumePrerender(
  {
    variant,
    entry,
    postponed,
    stored,
    cache,
  }: {
    variant: PrerenderOutput
    entry: PrerenderOutput
    postponed: string
    stored?: PrerenderGroupBlob['variants'][string]
    // how the shell the routing edge function asks for is cached (a stored group, or a route's shell
    // that is never upgraded); without it, it's revalidated on every request
    cache?: StoredCache
  },
  args: ProduceRequest,
): Promise<Produced | undefined> {
  const { request } = args
  const { rsc } = manifest
  const isRSCRequest = Boolean(rsc) && request.headers.get(rsc.header) === '1'
  const isPrefetch = isRSCRequest && request.headers.get(rsc.prefetchHeader) === '1'
  const output = computeOutputsById.get(variant.parentOutputId)
  if (!output || isPrefetch || (variant !== entry && !isRSCRequest)) {
    return
  }
  const resume = { postponed, headers: entry.resumeHeaders }
  if (isRSCRequest) {
    return invokeHandler(output, args, { resume })
  }
  if (!stored) {
    return
  }
  if (request.headers.has(PPR_SHELL_HEADER)) {
    // the routing edge function composes the page: it gets the postponed state and the shell, and
    // resumes itself, so this is cached like the shell would be
    const state = Buffer.from(postponed)
    const response = new Response(
      request.method === 'HEAD' ? null : Buffer.concat([state, Buffer.from(stored.body, 'base64')]),
      { status: stored.status, headers: stored.headers },
    )
    response.headers.set(POSTPONED_LENGTH_HEADER, String(state.byteLength))
    return cache ? { kind: 'stored', response, cache } : { kind: 'shell', response }
  }

  // the shell goes out right away, the resumed part streams after it once Next produces it
  const shell = Buffer.from(stored.body, 'base64')
  const body =
    request.method === 'HEAD'
      ? null
      : new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(shell)
            try {
              const resumed = await finalize(await invokeHandler(output, args, { resume }), request)
              if (resumed.body) {
                const reader = resumed.body.getReader()
                for (;;) {
                  const { done, value } = await reader.read()
                  if (done) {
                    break
                  }
                  controller.enqueue(value)
                }
              }
            } catch (error) {
              // the shell is already out, so the page can only end short
              getLogger().withError(error).error('PPR resume error')
            }
            controller.close()
          },
        })
  return {
    kind: 'resume',
    response: new Response(body, { status: stored.status, headers: stored.headers }),
  }
}
