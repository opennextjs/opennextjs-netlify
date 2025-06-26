import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const response = getResponse(request)

  response.headers.append('Deno' in globalThis ? 'x-deno' : 'x-node', Date.now().toString())
  response.headers.set('x-hello-from-middleware-res', 'hello')

  return response
}

const getResponse = (request: NextRequest) => {
  const requestHeaders = new Headers(request.headers)

  requestHeaders.set('x-hello-from-middleware-req', 'hello')

  if (request.nextUrl.pathname === '/test/cached') {
    return NextResponse.next({
      request: {
        headers: new Headers({
          ...requestHeaders,
          'netlify-cdn-cache-control': 's-maxage=31536000, durable',
        }),
      },
    })
  }

  if (request.nextUrl.pathname === '/test/uncached') {
    return NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    })
  }

  return NextResponse.json({ error: 'Error' }, { status: 500 })
}
