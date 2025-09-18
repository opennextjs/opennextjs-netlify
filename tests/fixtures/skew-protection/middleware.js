import { NextResponse } from 'next/server'

/**
 * @param {import('next/server').NextRequest} request
 */
export function middleware(request) {
  const parsedVariant = JSON.parse(process.env.SKEW_VARIANT)

  if (request.nextUrl.pathname === '/middleware/next') {
    return NextResponse.next()
  }

  if (request.nextUrl.pathname === '/middleware/redirect') {
    const url = request.nextUrl.clone()
    url.pathname = `/middleware/redirect-${parsedVariant.toLowerCase()}`
    return NextResponse.redirect(url)
  }

  if (request.nextUrl.pathname === '/middleware/rewrite') {
    const url = request.nextUrl.clone()
    url.pathname = `/middleware/rewrite-${parsedVariant.toLowerCase()}`
    return NextResponse.rewrite(url)
  }

  if (request.nextUrl.pathname === '/middleware/json') {
    return NextResponse.json(parsedVariant)
  }
}

export const config = {
  matcher: '/middleware/:path*',
}
