export default function middleware() {
  return new Response('hello from middleware')
}

export const config = {
  matcher: '/hello/world.txt',
}
