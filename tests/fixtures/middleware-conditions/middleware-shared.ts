import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const response: NextResponse = NextResponse.next()

  // report Next.js Middleware Runtime (not the execution runtime, but target runtime)
  // @ts-expect-error EdgeRuntime global not declared
  response.headers.append('x-runtime', typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : 'node')
  response.headers.set('x-hello-from-middleware-res', 'hello')

  return response
}
