import { type NextRequest, NextResponse } from 'next/server'
import { join } from 'path'

export default async function middleware(req: NextRequest) {
  return NextResponse.json({ message: 'Hello, world!', joined: join('a', 'b') })
}

export const config = {
  runtime: 'nodejs',
}
