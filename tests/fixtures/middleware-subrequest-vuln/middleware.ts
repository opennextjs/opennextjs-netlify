import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'

import packageJson from 'next/package.json'

export async function middleware(request: NextRequest) {
  const response = NextResponse.next()

  response.headers.set('x-test-used-middleware', 'true')
  response.headers.set('x-test-used-next-version', packageJson.version)

  return response
}
