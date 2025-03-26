import { getDeployStore } from '@netlify/blobs'
import { Context } from '@netlify/functions'

// publish or unpublish "cms content" depending on the sent operation
export default async function handler(_request: Request, context: Context) {
  const store = getDeployStore({ name: 'cms-content', consistency: 'strong' })
  const BLOB_KEY = 'key'

  const operation = context.params['operation']

  if (operation === 'publish') {
    await store.setJSON(BLOB_KEY, { content: true })
  }

  if (operation === 'unpublish') {
    await store.delete(BLOB_KEY)
  }

  return Response.json({ ok: true })
}

export const config = {
  path: '/cms/:operation',
}
