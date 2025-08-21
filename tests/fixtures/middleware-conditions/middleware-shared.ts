import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const response: NextResponse = NextResponse.next()

  response.headers.set('x-hello-from-middleware-res', 'hello')

  return response
}
