import { Suspense } from 'react'
import { connection } from 'next/server'
import { cacheLife } from 'next/cache'

async function getCachedTime() {
  'use cache'
  cacheLife({ revalidate: 60, expire: 3600 })
  return new Date().toISOString()
}

async function DynamicContent() {
  await connection()
  return <p data-testid="dynamic-date-now">{new Date().toISOString()}</p>
}

// Cached static shell with a dynamic hole: prerendered with postponed state
export default async function MixedPage() {
  return (
    <main>
      <h1>Mixed page</h1>
      <p data-testid="cached-date-now">{await getCachedTime()}</p>
      <Suspense fallback={<p data-testid="suspense-fallback">loading...</p>}>
        <DynamicContent />
      </Suspense>
    </main>
  )
}
