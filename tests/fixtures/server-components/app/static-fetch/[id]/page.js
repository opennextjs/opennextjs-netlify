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
  const { id } = await params
  const data = await getData({ id })

  return (
    <>
      <h1>Hello, Statically fetched show {data.id}</h1>
      <p>Paths /1 and /2 prerendered; other paths not found</p>
      <dl>
        <dt>Show</dt>
        <dd>{data.name}</dd>
        <dt>Param</dt>
        <dd>{id}</dd>
        <dt>Time</dt>
        <dd data-testid="date-now">{new Date().toISOString()}</dd>
      </dl>
    </>
  )
}
