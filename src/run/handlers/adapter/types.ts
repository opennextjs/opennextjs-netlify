// The contracts between the adapter's layers: what producers get, what drives an invocation, and
// what a produced response tells finalization.
import type { Span } from '@opentelemetry/api'
import type { RequestMeta } from 'next-with-adapters/dist/server/request-meta.js'

import type { ResolveRoutesResult } from '../../../adapter-runtime-shared/next-routing.js'
import type { RequestContext } from '../request-context.cjs'
import type { getTracer } from '../tracer.cjs'

/**
 * The part of the request context the adapter uses: background work. Logging, tracing and
 * request-scoped memoization reach the rest through `getRequestContext()` on their own. The other
 * fields are how standalone's cache handler tells the response what it found; here the response and
 * `Produced` carry that, and this type keeps it that way.
 */
export type AdapterRequestContext = Pick<
  RequestContext,
  'trackBackgroundWork' | 'backgroundWorkPromise'
>

// Next's mid-render callbacks (`requestMeta`), built for each request (createNextCallbacks)
export type NextCallbacks = {
  render404: NonNullable<RequestMeta['render404']>
  revalidate: NonNullable<RequestMeta['revalidate']>
}

// a request as the layers producing its response see it
export type ProduceRequest = {
  request: Request
  requestContext: AdapterRequestContext
  resolution: ResolveRoutesResult
  tracer: ReturnType<typeof getTracer>
  span?: Span
  // set when rendering the error page for this status (like Next's router does with res.statusCode)
  invokeStatus?: number
  nextCallbacks: NextCallbacks
  // the request's own render: finalizes its headers as Next commits them (`finalizeNext`)
  commit?: (response: Response) => Response
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
 * What the prerender store knows about a response it serves, for its cache headers. A rendered
 * response says it itself (`x-next-cache-tags`, `cache-control`).
 */
export type StoredCache = {
  // the group's policy; 0 is a render that couldn't be stored, cached as Next's own response says
  revalidate: number | false
  expire?: number
  tags: string[]
  // when the stored response was generated, the CDN counts its age from there (not on a MISS)
  lastModified?: number
  // how the prerender store served it: a stale response must not be cached as fresh
  nextCache: 'HIT' | 'STALE' | 'MISS'
}

/**
 * A response and what `finalize` needs to know to turn it into the platform response. Producers
 * (prerender groups, invocation, static files, error pages) leave the CDN headers to `finalize`.
 */
export type Produced =
  // Next's rendered response: its cache-control is translated for the CDN
  | { kind: 'next'; response: Response }
  // a stored response, cached as the store says
  | { kind: 'stored'; response: Response; cache: StoredCache }
  // per request: a fallback shell is revalidated on every request, a PPR resume is never stored
  | { kind: 'shell' | 'resume'; response: Response }
  // stored static HTML, a fully static page is cached for a year
  | { kind: 'static-page'; response: Response; fullyStatic: boolean }
  // an error page: what rendered it, served with this status
  | { kind: 'error'; status: 404 | 500; produced: Produced }
  // complete as is
  | { kind: 'final'; response: Response }
  // the request's own render, finalized when Next committed its headers (`ProduceRequest.commit`)
  | { kind: 'committed'; response: Response }
  // a render that failed before its headers: dispatch answers with the 500 page, `response` is the
  // plain 500 for whoever doesn't (a regeneration, which then doesn't store it)
  | { kind: 'failed'; response: Response }
