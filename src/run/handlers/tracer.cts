import { getTracer as otelGetTracer } from '@netlify/otel'
// Here we need to actually import `trace` from @opentelemetry/api to add extra wrappers
// other places should import `getTracer` from this module
import { trace } from '@netlify/otel/opentelemetry'
import type { Span } from '@netlify/otel/opentelemetry'

import { getRequestContext, type RequestContext } from './request-context.cjs'

const spanMeta = new WeakMap<Span, { start: number; name: string }>()
const spanCounter = new WeakMap<RequestContext, number>()

function spanHook(span: Span): Span {
  const originalEnd = span.end.bind(span)

  span.end = (endTime) => {
    originalEnd(endTime)

    const meta = spanMeta.get(span)
    if (meta) {
      const requestContext = getRequestContext()
      if (requestContext?.captureServerTiming) {
        const duration = (typeof endTime === 'number' ? endTime : performance.now()) - meta.start

        const serverTiming = requestContext.serverTiming ?? ''
        const currentRequestSpanCounter = spanCounter.get(requestContext) ?? 1

        requestContext.serverTiming = `${serverTiming}${serverTiming.length === 0 ? '' : ', '}s${currentRequestSpanCounter};dur=${duration};desc="${meta.name}"`

        spanCounter.set(requestContext, currentRequestSpanCounter + 1)
      }
    }

    spanMeta.delete(span)
  }

  return span
}

type NetlifyOtelTracer = NonNullable<ReturnType<typeof otelGetTracer>>

const memoizedTracersForRequests = new WeakMap<RequestContext, NetlifyOtelTracer | undefined>()

export function getTracer(): NetlifyOtelTracer | undefined {
  const requestContext = getRequestContext()
  if (!requestContext) {
    return undefined
  }

  if (memoizedTracersForRequests.has(requestContext)) {
    return memoizedTracersForRequests.get(requestContext)
  }

  const tracer = otelGetTracer('Next.js Runtime')

  if (!tracer) {
    // don't attempt to call `otelGetTracer` again for this request context
    memoizedTracersForRequests.set(requestContext, undefined)
    return undefined
  }

  // we add hooks to capture span start and end events to be able to add server-timings
  // while preserving OTEL api
  const startSpan = tracer.startSpan.bind(tracer)
  tracer.startSpan = (
    ...args: Parameters<NetlifyOtelTracer['startSpan']>
  ): ReturnType<NetlifyOtelTracer['startSpan']> => {
    const span = startSpan(...args)
    spanMeta.set(span, { start: performance.now(), name: args[0] })
    return spanHook(span)
  }

  const startActiveSpan = tracer.startActiveSpan.bind(tracer)

  // @ts-expect-error Target signature provides too few arguments. Expected 4 or more, but got 2.
  tracer.startActiveSpan = (
    ...args: Parameters<NetlifyOtelTracer['startActiveSpan']>
  ): ReturnType<NetlifyOtelTracer['startActiveSpan']> => {
    const [name, ...restOfArgs] = args

    const augmentedArgs = restOfArgs.map((arg) => {
      // callback might be 2nd, 3rd or 4th argument depending on used signature
      // only callback can be a function so target that and keep rest arguments as-is
      if (typeof arg === 'function') {
        return (span: Span) => {
          spanMeta.set(span, { start: performance.now(), name: args[0] })
          spanHook(span)
          return arg(span)
        }
      }

      return arg
    }) as typeof restOfArgs

    return startActiveSpan(name, ...augmentedArgs)
  }

  memoizedTracersForRequests.set(requestContext, tracer)

  return tracer
}

export function recordWarning(warning: Error, span?: Span) {
  const spanToRecordWarningOn = span ?? trace.getActiveSpan()
  if (!spanToRecordWarningOn) {
    return
  }

  spanToRecordWarningOn.recordException(warning)
  spanToRecordWarningOn.setAttributes({
    severity: 'alert',
    warning: true,
  })
}

export { withActiveSpan } from '@netlify/otel'
