import { purgeCache } from '@netlify/functions'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const pathToPurge = url.searchParams.get('path')

  if (!pathToPurge) {
    return NextResponse.json(
      {
        status: 'error',
        error: 'missing "path" query parameter',
      },
      { status: 400 },
    )
  }
  try {
    await purgeCache({ tags: [`_N_T_${encodeURI(pathToPurge)}`] })
    return NextResponse.json(
      {
        status: 'ok',
      },
      {
        status: 200,
      },
    )
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        error: error.toString(),
      },
      {
        status: 500,
      },
    )
  }
}

export const dynamic = 'force-dynamic'
