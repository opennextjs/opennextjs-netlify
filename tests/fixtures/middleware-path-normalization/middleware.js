export { middleware } from './middleware-shared'

// path-scoped matcher
export const config = {
  matcher: ['/admin/:path*', '/api/:path*', '/:tenant/dash/:path*'],
}
