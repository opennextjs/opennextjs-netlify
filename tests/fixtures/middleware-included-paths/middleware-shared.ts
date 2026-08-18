import { NextRequest, NextResponse } from 'next/server'

export async function middleware(request: NextRequest) {
  const response = NextResponse.next()

  response.headers.set('x-hello-from-middleware-res', 'hello')
  // report Next.js Middleware Runtime (not the execution runtime, but target runtime)
  // @ts-expect-error EdgeRuntime global not declared
  response.headers.append('x-runtime', typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : 'node')

  response.headers.set('x-pathname', request.nextUrl.pathname)
  response.headers.set('x-locale', request.nextUrl.locale)

  return response
}
