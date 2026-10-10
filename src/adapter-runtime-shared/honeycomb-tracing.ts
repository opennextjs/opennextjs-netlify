// Debugging aid: exports the runtime's OTel spans to Honeycomb when HONEYCOMB_API_KEY is set, with the
// routing edge function and the server handler joined into one trace. Self-contained so that removing
// it is deleting this file and its call sites. Without the env var nothing is imported and every
// helper just calls through.
import type { Attributes } from '@netlify/otel/opentelemetry'

type WaitUntil = ((promise: Promise<unknown>) => void) | undefined

type Tracing = {
  netlifyOtel: typeof import('@netlify/otel')
  api: typeof import('@netlify/otel/opentelemetry')
  flush: () => Promise<unknown>
}

// on a global: the routing edge function loads two copies of this module (its entry's and
// middleware's), only one of them is set up
const globals = globalThis as { __nfHoneycombTracing?: { tracing?: Tracing } }
globals.__nfHoneycombTracing ??= {}
const state = globals.__nfHoneycombTracing

const getEnv = (name: string): string | undefined =>
  (
    globalThis as { Netlify?: { env: { get: (key: string) => string | undefined } } }
  ).Netlify?.env.get(name) ?? globalThis.process?.env[name]

const interop = async <T extends object>(module: Promise<T>): Promise<T> => {
  const loaded = await module
  return ('default' in loaded ? loaded.default : loaded) as T
}

/** Call once at module scope, before anything asks for a tracer. */
export async function setupHoneycombTracing(serviceName: string): Promise<void> {
  const apiKey = getEnv('HONEYCOMB_API_KEY')
  if (!apiKey || state.tracing) {
    return
  }
  try {
    // The CJS packages come out of the bundle as a default export only.
    const [
      netlifyOtel,
      api,
      { createTracerProvider },
      { SimpleSpanProcessor },
      { OTLPTraceExporter },
    ] = await Promise.all([
      import('@netlify/otel'),
      import('@netlify/otel/opentelemetry'),
      interop(import('@netlify/otel/bootstrap')),
      interop(import('@opentelemetry/sdk-trace-node')),
      interop(import('@opentelemetry/exporter-trace-otlp-http')),
    ])
    const processor = new SimpleSpanProcessor(
      new OTLPTraceExporter({
        url: `${getEnv('HONEYCOMB_API_ENDPOINT') ?? 'https://api.honeycomb.io'}/v1/traces`,
        headers: { 'x-honeycomb-team': apiKey },
      }),
    )
    createTracerProvider({
      serviceName,
      serviceVersion: getEnv('DEPLOY_ID') ?? '',
      deploymentEnvironment: getEnv('CONTEXT') ?? '',
      siteUrl: getEnv('URL') ?? '',
      siteId: getEnv('SITE_ID') ?? '',
      siteName: getEnv('SITE_NAME') ?? '',
      spanProcessors: [processor],
    })
    state.tracing = { netlifyOtel, api, flush: () => processor.forceFlush() }
  } catch (error) {
    console.error('Honeycomb tracing setup failed', error)
  }
}

/**
 * Runs a request handler as a child of the trace the request carries (`traceparent`), then keeps
 * the invocation alive until the spans are exported: a frozen Lambda or a finished edge invocation
 * would drop exports still in flight.
 */
export async function withHoneycombTracing<T>(
  request: Request,
  waitUntil: WaitUntil,
  fn: () => Promise<T>,
): Promise<T> {
  const { tracing } = state
  if (!tracing) {
    return fn()
  }
  const { context: otelContext, propagation } = tracing.api
  const parent = propagation.extract(otelContext.active(), Object.fromEntries(request.headers))
  // consumed here: Next would otherwise start its own root span from it, beside ours
  request.headers.delete('traceparent')
  request.headers.delete('tracestate')
  try {
    return await otelContext.with(parent, fn)
  } finally {
    waitUntil?.(
      tracing.flush().catch((error) => console.error('Honeycomb span export failed', error)),
    )
  }
}

/** A span around a forward to the origin, propagating the trace on the forwarded request's headers. */
export async function traceForward(
  name: string,
  headers: Headers,
  fn: () => Promise<Response>,
): Promise<Response> {
  const { tracing } = state
  const span = tracing?.netlifyOtel.getTracer('Next.js Runtime')?.startSpan(name)
  if (!tracing || !span) {
    return fn()
  }
  const { context: otelContext, propagation, trace } = tracing.api
  propagation.inject(trace.setSpan(otelContext.active(), span), headers, {
    set: (carrier, key, value) => carrier.set(key, value),
  })
  try {
    const response = await fn()
    span.setAttribute('http.status_code', response.status)
    return response
  } finally {
    span.end()
    headers.delete('traceparent')
    headers.delete('tracestate')
  }
}

export function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const { tracing } = state
  if (!tracing) {
    return fn()
  }
  const { getTracer, withActiveSpan } = tracing.netlifyOtel
  return withActiveSpan(getTracer('Next.js Runtime'), name, () => fn())
}

export function setActiveSpanAttributes(attributes: Attributes): void {
  state.tracing?.api.trace.getActiveSpan()?.setAttributes(attributes)
}
