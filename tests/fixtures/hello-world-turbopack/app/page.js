import { connection } from 'next/server'

export default async function Page() {
  await connection()
  return <h1>Hello, Next.js!</h1>
}
