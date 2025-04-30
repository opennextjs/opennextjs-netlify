import { revalidateTag } from 'next/cache'
import { NextRequest } from 'next/server'

export async function GET(request: NextRequest, { params }) {
  const { slug } = await params

  const tagToInvalidate = slug.join('/')

  revalidateTag(tagToInvalidate)

  return Response.json({ tagToInvalidate })
}
