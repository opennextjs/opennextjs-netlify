import wasm from './add.wasm?module'
const instance$ = WebAssembly.instantiate(wasm)

async function increment(a) {
  const { instance } = await instance$
  return instance.exports.add_one(a)
}
export default async function middleware(request) {
  const input = Number(request.nextUrl.searchParams.get('input')) || 1
  const value = await increment(input)
  return new Response(null, { headers: { data: JSON.stringify({ input, value }) } })
}
blah blah - this should not build
export const config = {
  matcher: '/wasm',
}
