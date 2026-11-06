import { NextResponse } from 'next/server'

// Simulates auth gate: requests without `auth` cookie to gated paths are blocked.
// `x-middleware-seen-path` header reports pathname middleware made decision on.
export function middleware(request) {
  const pathname = request.nextUrl.pathname
  const isGated =
    pathname.startsWith('/admin') || pathname.startsWith('/api') || pathname.includes('/dash')

  if (isGated && !request.cookies.get('auth')) {
    return NextResponse.json(
      { error: 'BLOCKED-BY-MIDDLEWARE' },
      { status: 401, headers: { 'x-middleware-seen-path': pathname } },
    )
  }

  const response = NextResponse.next()
  response.headers.set('x-middleware-seen-path', pathname)
  return response
}
