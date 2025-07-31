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

  if (request.nextUrl.pathname === '/test/next/') {
    return NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    })
  }

  if (request.nextUrl.pathname === '/test/redirect/') {
    return NextResponse.redirect(new URL('/other', request.url))
  }

  if (request.nextUrl.pathname === '/test/redirect-with-headers/') {
    return NextResponse.redirect(new URL('/other', request.url), {
      headers: { 'x-header-from-redirect': 'hello' },
    })
  }

  if (request.nextUrl.pathname === '/test/rewrite-internal/') {
    return NextResponse.rewrite(new URL('/rewrite-target', request.url), {
      request: {
        headers: requestHeaders,
      },
    })
  }

  if (request.nextUrl.pathname === '/test/rewrite-external/') {
    const requestURL = new URL(request.url)
    const externalURL = new URL(requestURL.searchParams.get('external-url') as string)

    externalURL.searchParams.set('from', 'middleware')

    return NextResponse.rewrite(externalURL, {
      request: {
        headers: requestHeaders,
      },
    })
  }

  return NextResponse.json({ error: 'Error' }, { status: 500 })
}

export const config = {
  runtime: 'nodejs',
}
