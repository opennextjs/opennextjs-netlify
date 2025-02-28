import { purgeCache, Config } from '@netlify/functions'

export default async function handler(request: Request) {
  const url = new URL(request.url)
  const pathToPurge = url.searchParams.get('path')

  if (!pathToPurge) {
    return Response.json(
      {
        status: 'error',
        error: 'missing "path" query parameter',
      },
      { status: 400 },
    )
  }
  try {
    await purgeCache({ tags: [`_N_T_${encodeURI(pathToPurge)}`] })
    return Response.json(
      {
        status: 'ok',
      },
      {
        status: 200,
      },
    )
  } catch (error) {
    return Response.json(
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

export const config: Config = {
  path: '/api/purge-cdn',
}
