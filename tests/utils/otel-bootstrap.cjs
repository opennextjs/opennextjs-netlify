// Registers an OpenTelemetry SDK the way Netlify's Functions bootstrap does: globally, and
// outside the application's `instrumentation.ts` hook. Preloaded with `--require` so that
// registration happens before the server handler is imported.
//
// Goes through `@netlify/otel`'s own `createTracerProvider` rather than registering a bare
// `NodeTracerProvider`, because that is what also installs the global accessor that
// `getTracer()` reads - and our runtime uses `getTracer()` to decide whether there is a
// provider worth patching.
const { createTracerProvider } = require('@netlify/otel/bootstrap')

createTracerProvider({
  serviceName: 'integration-test',
  serviceVersion: '0.0.0',
  deploymentEnvironment: 'test',
  siteUrl: 'https://example.netlify.app',
  siteId: 'test-site-id',
  siteName: 'test-site',
  // No span processors: nothing should be exported anywhere during tests. Span ids are still
  // generated, which is all this needs to reproduce.
  spanProcessors: [],
})
