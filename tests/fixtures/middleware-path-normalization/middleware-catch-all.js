export { middleware } from './middleware-shared'

// catch-all matcher, gating is done in middleware code based on pathname
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
