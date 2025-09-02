import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const url = request.nextUrl

  // if path ends with /json we create response in middleware, otherwise we pass it through
  // to next server to get page or api response from it
  const response = url.pathname.includes('/json')
    ? NextResponse.json({
        requestUrlPathname: new URL(request.url).pathname,
        nextUrlPathname: request.nextUrl.pathname,
        nextUrlLocale: request.nextUrl.locale,
      })
    : NextResponse.next()

  response.headers.set('x-test-used-middleware', 'true')
  // report Next.js Middleware Runtime (not the execution runtime, but target runtime)
  // @ts-expect-error EdgeRuntime global not declared
  response.headers.append('x-runtime', typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : 'node')

  return response
}
