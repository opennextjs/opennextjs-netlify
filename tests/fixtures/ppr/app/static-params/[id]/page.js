import { Suspense } from 'react'
import { connection } from 'next/server'

export async function generateStaticParams() {
  return [{ id: '1' }, { id: '2' }]
}

async function getData(params) {
  await connection()
  const res = await fetch(`https://api.tvmaze.com/shows/${params.id}`, {
    next: {
      tags: [`show-${params.id}`],
    },
  })
  await new Promise((res) => setTimeout(res, 3000))
  return res.json()
}

async function Content(params) {
  const data = await getData(params)

  return (
    <dl>
      <dt>Show</dt>
      <dd>{data.name}</dd>
      <dt>Param</dt>
      <dd>{params.id}</dd>
      <dt>Time</dt>
      <dd data-testid="date-now">{new Date().toISOString()}</dd>
    </dl>
  )
}

// This is a dynamic page (segment) where all params are statically generated
export default async function DynamicPageWithStaticParams({ params }) {
  const { id } = await params

  return (
    <main>
      <h1>Dynamic Page (static params): {id}</h1>
      <Suspense fallback={<div>loading...</div>}>
        <Content id={id} />
      </Suspense>
    </main>
  )
}
