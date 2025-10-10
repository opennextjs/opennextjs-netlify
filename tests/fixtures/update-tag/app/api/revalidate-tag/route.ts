import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const tagToRevalidate = url.searchParams.get('tag') ?? 'collection'
  const expire = url.searchParams.has('expire') ? parseInt(url.searchParams.get('expire')) : 0

  console.log(`Revalidating tag: ${tagToRevalidate}, expire: ${expire}`)

  revalidateTag(tagToRevalidate, { expire })
  return NextResponse.json({ revalidated: true, now: new Date().toISOString() })
}

export const dynamic = 'force-dynamic'
