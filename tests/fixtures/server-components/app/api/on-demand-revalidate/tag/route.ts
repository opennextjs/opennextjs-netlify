import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag as typedRevalidateTag } from 'next/cache'

// https://github.com/vercel/next.js/pull/83822 deprecated revalidateTag with single argument, but it still is working
// types however do not allow single param usage, so typing as any to workaround type error
const revalidateTag = typedRevalidateTag as any

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const tagToRevalidate = url.searchParams.get('tag') ?? 'collection'

  revalidateTag(tagToRevalidate)
  return NextResponse.json({ revalidated: true, now: new Date().toISOString() })
}

export const dynamic = 'force-dynamic'
