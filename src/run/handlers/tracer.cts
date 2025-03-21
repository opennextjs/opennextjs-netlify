// Here we need to actually import `trace` from @opentelemetry/api to add extra wrappers
// other places should import `getTracer` from this module
// eslint-disable-next-line no-restricted-imports
import { Span, trace, Tracer } from '@opentelemetry/api'
import { SugaredTracer, wrapTracer } from '@opentelemetry/api/experimental'

import { getRequestContext, RequestContext } from './request-context.cjs'

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

// startSpan and startActiveSpan don't automatically handle span ending and error handling
// so this typing just tries to enforce not using those methods in our code
// we should be using withActiveSpan (and optionally withSpan) instead
export type RuntimeTracer = Omit<SugaredTracer, 'startSpan' | 'startActiveSpan'>

let tracer: RuntimeTracer | undefined

export function getTracer(): RuntimeTracer {
  if (!tracer) {
    const baseTracer = trace.getTracer('Next.js Runtime')

    // we add hooks to capture span start and end events to be able to add server-timings
    // while preserving OTEL api
    const startSpan = baseTracer.startSpan.bind(baseTracer)
    baseTracer.startSpan = (
      ...args: Parameters<Tracer['startSpan']>
    ): ReturnType<Tracer['startSpan']> => {
      const span = startSpan(...args)
      spanMeta.set(span, { start: performance.now(), name: args[0] })
      return spanHook(span)
    }

    const startActiveSpan = baseTracer.startActiveSpan.bind(baseTracer)

    // @ts-expect-error Target signature provides too few arguments. Expected 4 or more, but got 2.
    baseTracer.startActiveSpan = (
      ...args: Parameters<Tracer['startActiveSpan']>
    ): ReturnType<Tracer['startActiveSpan']> => {
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

    // finally use SugaredTracer
    tracer = wrapTracer(baseTracer)
  }

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
