// bcrypt is using C++ Addons (.node binaries) which are unsupported currently
// example copied from https://nextjs.org/blog/next-15-2#nodejs-middleware-experimental
import bcrypt from 'bcrypt'

const API_KEY_HASH = process.env.API_KEY_HASH // Pre-hashed API key in env

export default async function middleware(req) {
  const apiKey = req.headers.get('x-api-key')

  if (!apiKey || !(await bcrypt.compare(apiKey, API_KEY_HASH))) {
    return new Response('Forbidden', { status: 403 })
  }

  console.log('API key validated')
}

export const config = {
  runtime: 'nodejs',
}
