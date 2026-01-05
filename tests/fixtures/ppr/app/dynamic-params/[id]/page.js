import { Suspense } from 'react'
import { connection } from 'next/server'

// no `generateStaticParams` export

async function getData(id) {
  await connection()
  const res = await fetch(`https://api.tvmaze.com/shows/${id}`, {
    next: {
      tags: [`show-${id}`],
    },
  })
  await new Promise((res) => setTimeout(res, 3000))
  return res.json()
}

async function Content({ id }) {
  const data = await getData(await id)

  return (
    <>
      <h1>Dynamic Page (dynamic params): {id}</h1>
      <dl>
        <dt>Show</dt>
        <dd>{data.name}</dd>
        <dt>Param</dt>
        <dd>{await id}</dd>
        <dt>Time</dt>
        <dd data-testid="date-now">{new Date().toISOString()}</dd>
      </dl>
    </>
  )
}

// This is a dynamic page (segment) where params are NOT statically generated (dynamic, at request time)
export default async function DynamicPageWithDynamicParams({ params }) {
  return (
    <main>
      <Suspense fallback={<div>loading...</div>}>
        <Content id={params.then(({ id }) => id)} />
      </Suspense>
    </main>
  )
}
