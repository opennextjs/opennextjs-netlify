import { redirect } from 'next/navigation'

export async function GET(request) {
  const ref = new URL(request.url).searchParams.get('ref')
  redirect(`/test/public-prefix/target?ref=${ref}`)
}
