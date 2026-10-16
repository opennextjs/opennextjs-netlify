import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const pathToRevalidate = url.searchParams.get('path') ?? '/static-fetch/[id]/page'

  const type = url.searchParams.get('type') as 'page' | 'layout' | null

  revalidatePath(pathToRevalidate, type ?? undefined)
  return NextResponse.json({ revalidated: true, now: new Date().toISOString() })
}

export const dynamic = 'force-dynamic'
