import { NextResponse } from 'next/server'

export const runtime = 'edge'

export default () => {
  const response = NextResponse.json({ ok: true })
  response.cookies.set('session', 'http-only-value', { httpOnly: true, path: '/' })
  return response
}
