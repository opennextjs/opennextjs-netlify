import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    msg: 'Hi!',
  })
}

export const dynamic = 'force-dynamic'
