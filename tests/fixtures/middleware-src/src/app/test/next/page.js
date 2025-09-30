import { headers } from 'next/headers'

export default async function Page() {
  const headersList = await headers()
  const message = headersList.get('x-hello-from-middleware-req')

  return (
    <main>
      <h1>Message from middleware: {message}</h1>
    </main>
  )
}
