export { middleware } from './middleware-shared'

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
  runtime: 'nodejs',
}
