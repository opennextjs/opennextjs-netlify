import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const tagToRevalidate = url.searchParams.get('tag') ?? 'collection'

  let profile: Parameters<typeof revalidateTag>[1] | undefined | null
  if (url.searchParams.has('profile')) {
    profile = url.searchParams.get('profile')
  } else if (url.searchParams.has('expire')) {
    profile = {
      expire: parseInt(url.searchParams.get('expire')),
    }
  }

  if (profile) {
    console.log(`Revalidating tag: ${tagToRevalidate}, profile: ${JSON.stringify(profile)}`)

    revalidateTag(tagToRevalidate, profile)
    return NextResponse.json({ revalidated: true, now: new Date().toISOString() })
  } else {
    return NextResponse.json({ error: 'Missing profile or expire query param' }, { status: 400 })
  }
}

export const dynamic = 'force-dynamic'
