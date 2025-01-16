import { getDeployStore } from '@netlify/blobs'
import { Context } from '@netlify/functions'

function numberOrNull(value: string | null) {
  if (!value) {
    return null
  }

  const maybeNumber = parseInt(value)
  return isNaN(maybeNumber) ? null : maybeNumber
}

// intentionally using Netlify Function to not hit Next.js server handler function instance
// to avoid potentially resuming suspended execution
export default async function handler(_request: Request, context: Context) {
  const slug = context.params['slug']

  const store = getDeployStore({ name: 'get-static-props-tracker', consistency: 'strong' })

  const [start, end] = await Promise.all([store.get(`${slug}-start`), store.get(`${slug}-end`)])

  return Response.json({ slug, start: numberOrNull(start), end: numberOrNull(end) })
}

export const config = {
  path: '/read-static-props-blobs/:slug',
}
