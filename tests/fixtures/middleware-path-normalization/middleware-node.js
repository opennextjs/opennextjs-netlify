export { middleware } from './middleware-shared'

// path-scoped matcher
export const config = {
  runtime: 'nodejs',
  matcher: ['/admin/:path*', '/api/:path*', '/:tenant/dash/:path*'],
}
