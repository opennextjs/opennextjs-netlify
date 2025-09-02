import { Suspense } from 'react'
import { connection } from 'next/server'

export async function generateStaticParams() {
  return [{ dynamic: '1' }, { dynamic: '2' }]
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

export default async function DynamicPage({ params }) {
  const { dynamic } = await params

  return (
    <main>
      <h1>Dynamic Page: {dynamic}</h1>
      <Suspense fallback={<div>loading...</div>}>
        <Content id={dynamic} />
      </Suspense>
    </main>
  )
}
