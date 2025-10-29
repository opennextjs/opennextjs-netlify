import { revalidateTag as typedRevalidateTag } from 'next/cache'
import { NextRequest } from 'next/server'

// https://github.com/vercel/next.js/pull/83822 deprecated revalidateTag with single argument, but it still is working
// types however do not allow single param usage, so typing as any to workaround type error
const revalidateTag = typedRevalidateTag as any

export async function GET(request: NextRequest, { params }) {
  const { slug } = await params

  const tagToInvalidate = slug.join('/')
  let profile = undefined
  if (request.nextUrl.searchParams.has('expire')) {
    profile = { expire: parseInt(request.nextUrl.searchParams.get('expire')) }
  }

  revalidateTag(tagToInvalidate, profile)

  return Response.json({ tagToInvalidate })
}
