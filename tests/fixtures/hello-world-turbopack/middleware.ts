import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  return NextResponse.json({
    message: `Hello from middleware at ${request.nextUrl.pathname}`,
  })
}

export const config = {
  matcher: '/middleware/:path*',
}
