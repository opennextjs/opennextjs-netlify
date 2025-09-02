export function middleware() {
  return new Response('hello from middleware', {
    headers: {
      // report Next.js Middleware Runtime (not the execution runtime, but target runtime)
      // @ts-expect-error EdgeRuntime global not declared
      'x-runtime': typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : 'node',
    },
  })
}
