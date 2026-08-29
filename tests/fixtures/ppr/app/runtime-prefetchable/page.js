import { cacheLife } from 'next/cache'
import { Suspense } from 'react'

export const prefetch = 'partial'

export default async function Page({ searchParams }) {
  return (
    <main>
      <CachedContent />
      <Suspense fallback={<p>Loading search params...</p>}>
        <SearchParamsContent searchParams={searchParams} />
      </Suspense>
    </main>
  )
}

async function CachedContent() {
  'use cache'
  cacheLife({ stale: 120 })
  return <p id="cached-content">Cached content ({new Date().toISOString()})</p>
}

async function SearchParamsContent({ searchParams }) {
  'use cache: private'
  cacheLife({ stale: 30 })
  const { q } = await searchParams
  return <p>Search params: {q ?? 'none'}</p>
}
