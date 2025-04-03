import { getDeployStore } from '@netlify/blobs'
import { Context } from '@netlify/functions'

// publish or unpublish "cms content" depending on the sent operation
export default async function handler(_request: Request, context: Context) {
  const store = getDeployStore({ name: 'cms-content', consistency: 'strong' })

  const operation = context.params['operation']

  // root of optional catch-all route in Next.js sets 'index.html' as param
  // while it's undefined in the Netlify function, because we need to declare
  // path without wildcard
  const contentKey = context.params['0'] ?? 'index.html'

  if (operation === 'publish') {
    await store.setJSON(contentKey, { content: true })
  }

  if (operation === 'unpublish') {
    await store.delete(contentKey)
  }

  return Response.json({ ok: true })
}

export const config = {
  path: ['/cms/:operation/*', '/cms/:operation'],
}
