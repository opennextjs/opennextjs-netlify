import { connection } from 'next/server'

export const runtime = 'edge'

export default async function Page() {
  await connection()
  return <h1>Hello, Next.js!</h1>
}
