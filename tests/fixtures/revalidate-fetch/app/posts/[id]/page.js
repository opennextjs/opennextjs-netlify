const revalidateSeconds = +process.env.REVALIDATE_SECONDS || 5
const API_BASE = process.env.API_BASE || 'https://api.tvmaze.com/shows/'

export async function generateStaticParams() {
  return [{ id: '1' }, { id: '2' }]
}

async function getData(params) {
  const res = await fetch(new URL(params.id, API_BASE).href, {
    next: { revalidate: revalidateSeconds },
  })
  return res.json()
}

export default async function Page({ params }) {
  const { id } = await params
  const data = await getData({ id })

  return (
    <>
      <h1>Revalidate Fetch</h1>
      <p>Paths /1 and /2 prerendered; other paths rendered on-demand</p>
      <p>Revalidating every {revalidateSeconds} seconds</p>
      <dl>
        <dt>Show</dt>
        <dd data-testid="name">{data.name}</dd>
        <dt>Param</dt>
        <dd data-testid="id">{id}</dd>
        <dt>Time</dt>
        <dd data-testid="date-now">{Date.now()}</dd>
        <dt>Time from fetch response</dt>
        <dd data-testid="date-from-response">{data.date ?? 'no-date-in-response'}</dd>
      </dl>
    </>
  )
}
