import { cacheLife } from 'next/cache'

async function getData() {
  'use cache'
  cacheLife({ revalidate: 60, expire: 3600 })
  return { time: new Date().toISOString() }
}

// Fully cacheable page under cacheComponents: no dynamic holes, so no postponed state
export default async function UseCachePage() {
  const data = await getData()
  return (
    <main>
      <h1>Use cache page</h1>
      <p data-testid="date-now">{data.time}</p>
    </main>
  )
}
