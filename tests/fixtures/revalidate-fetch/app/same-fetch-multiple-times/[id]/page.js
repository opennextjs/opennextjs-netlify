const API_BASE = process.env.API_BASE || 'https://api.tvmaze.com/shows/'

async function doFetch(params) {
  const res = await fetch(new URL(params.id, API_BASE).href, {
    next: { revalidate: false },
  })
  return res.json()
}

async function getData(params) {
  // trigger fetches in parallel to ensure we only do one cache lookup for ongoing fetches
  const [data1, data2] = await Promise.all([doFetch(params), doFetch(params)])
  // also trigger fetch after to make sure we reuse already fetched cache
  const data3 = await doFetch(params)

  if (data1?.name !== data2?.name || data1?.name !== data3?.name) {
    throw new Error(
      `Should have 3 names that are the same, instead got [${data1?.name}, ${data2?.name}, ${data3?.name}]`,
    )
  }

  return data1
}

export default async function Page({ params }) {
  const data = await getData(params)

  return (
    <>
      <h1>Using same fetch multiple times</h1>
      <dl>
        <dt>Show</dt>
        <dd data-testid="name">{data.name}</dd>
        <dt>Param</dt>
        <dd data-testid="id">{params.id}</dd>
        <dt>Time</dt>
        <dd data-testid="date-now">{Date.now()}</dd>
        <dt>Time from fetch response</dt>
        <dd data-testid="date-from-response">{data.date ?? 'no-date-in-response'}</dd>
      </dl>
    </>
  )
}

// make page dynamic, but still use fetch cache
export const fetchCache = 'force-cache'
export const dynamic = 'force-dynamic'
