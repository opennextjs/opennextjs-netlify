import { type NextRequest, NextResponse } from 'next/server'
import { join } from 'path'

export default async function middleware(req: NextRequest) {
  const response = NextResponse.next()
  response.headers.set('x-added-middleware-headers-join', join('a', 'b'))
  return response
}

export const config = {
  runtime: 'nodejs',
}
