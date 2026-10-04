// The contracts between the adapter's layers: what producers get, what drives an invocation, and
// what a produced response tells finalization.
import type { Span } from '@opentelemetry/api'

import type { ResolveRoutesResult } from '../../../adapter-runtime-shared/next-routing.js'
import type { PrerenderGroupBlob } from '../../../shared/blob-types.cjs'
import type { RequestContext } from '../request-context.cjs'
import type { getTracer } from '../tracer.cjs'

/**
 * The part of the request context the adapter uses: background work, and the request Next's
 * mid-render callbacks (`render404`, `revalidate`) belong to. Logging, tracing and request-scoped
 * memoization reach the rest through `getRequestContext()` on their own. The other fields are how
 * standalone's cache handler tells the response what it found; here the response and `Produced`
 * carry that, and this type keeps it that way.
 */
export type AdapterRequestContext = Pick<
  RequestContext,
  'trackBackgroundWork' | 'backgroundWorkPromise' | 'originalRequest' | 'originalContext'
>

// a request as the layers producing its response see it
export type ProduceRequest = {
  request: Request
  requestContext: AdapterRequestContext
  resolution: ResolveRoutesResult
  tracer: ReturnType<typeof getTracer>
  span?: Span
  // set when rendering the error page for this status (like Next's router does with res.statusCode)
  invokeStatus?: number
}

// what the layer driving an invocation adds: the prerender store regenerating a group, PPR resuming
export type InvokeOptions = {
  // shared by the invocations regenerating one prerender group, so Next renders it once
  invocationId?: string
  // Next's response as is, without our CDN headers (to store it)
  raw?: boolean
  // PPR: resume a postponed render with this state and the output's `pprChain` headers
  resume?: { postponed: string; headers?: Record<string, string> }
  // PPR: a server action's re-render uses the resume data cache of the page's postponed state
  postponed?: string
  onCacheEntry?: (entry: {
    value?: {
      kind?: string
      postponed?: string
      html?: { toUnchunkedString?: () => string } | null
    } | null
  }) => void
}

/**
 * What a stored prerender group knows about the response it serves, for its cache headers. A
 * rendered response says it itself (`x-next-cache-tags`, `cache-control`).
 */
export type CacheInputs = {
  tags?: string[]
  // when the stored response was generated, the CDN counts its age from there
  lastModified?: number
  revalidate?: PrerenderGroupBlob['revalidate']
}

/**
 * A response and what `finalize` needs to know to turn it into the platform response. Producers
 * (prerender groups, invocation, static files, error pages) leave the CDN headers to `finalize`.
 */
export type Produced =
  // Next's response, rendered or stored: its cache-control is translated for the CDN
  | { kind: 'next'; response: Response; cache?: CacheInputs }
  // per request: a fallback shell is revalidated on every request, a PPR resume is never stored
  | { kind: 'shell' | 'resume'; response: Response }
  // stored static HTML, a fully static page is cached for a year
  | { kind: 'static-page'; response: Response; fullyStatic: boolean }
  // an error page: what rendered it, served with this status
  | { kind: 'error'; status: 404 | 500; produced: Produced }
  // complete as is
  | { kind: 'final'; response: Response }
