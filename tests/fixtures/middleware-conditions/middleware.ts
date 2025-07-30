import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const response: NextResponse = NextResponse.next()

  response.headers.set('x-hello-from-middleware-res', 'hello')

  return response
}

export const config = {
  matcher: [
    {
      source: '/foo',
      missing: [{ type: 'header', key: 'x-custom-header', value: 'custom-value' }],
    },
    {
      source: '/hello',
    },
    {
      source: '/nl/about',
      locale: false,
    },
  ],
  runtime: 'nodejs',
}
