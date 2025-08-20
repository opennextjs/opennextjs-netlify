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

  return response
}

// matcher copied from example in https://nextjs.org/docs/pages/building-your-application/routing/middleware#matcher
// with `excluded` segment added to exclusion
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - excluded (for testing localized routes and not just API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    '/((?!api|excluded|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
}
