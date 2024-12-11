export async function generateStaticParams() {
  return [{ id: '1' }, { id: '2' }]
}

async function getData(params) {
  const res = await fetch(`https://api.tvmaze.com/shows/${params.id}`, {
    next: {
      tags: [`show-${params.id}`],
    },
  })
  return res.json()
}

export default async function Page({ params }) {
  const data = await getData(params)

  return (
    <>
      <h1>Hello, Force Dynamically Rendered Server Component</h1>
      <p>Paths /1 and /2 prerendered; other paths not found</p>
      <dl>
        <dt>Show</dt>
        <dd>{data.name}</dd>
        <dt>Param</dt>
        <dd>{params.id}</dd>
        <dt>Time</dt>
        <dd data-testid="date-now">{new Date().toISOString()}</dd>
      </dl>
    </>
  )
}

export const dynamic = 'force-dynamic'
