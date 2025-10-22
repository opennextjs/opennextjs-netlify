import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export async function proxy(request: NextRequest) {
  const response = NextResponse.next()

  if (response) {
    response.headers.append('Deno' in globalThis ? 'x-deno' : 'x-node', Date.now().toString())
    // report Next.js Middleware Runtime (not the execution runtime, but target runtime)
    // @ts-expect-error EdgeRuntime global not declared
    response.headers.append('x-runtime', typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : 'node')
    response.headers.set('x-hello-from-middleware-res', 'hello')

    response.headers.set('x-next-url-pathname', request.nextUrl.pathname)

    return response
  }
}
