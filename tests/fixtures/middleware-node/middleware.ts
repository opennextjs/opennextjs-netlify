import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  console.log('Node.js Middleware request:', request.method, request.nextUrl.pathname)
}

export const config = {
  runtime: 'nodejs',
}
