export default function Page({ params }) {
  return (
    <>
      <h1>Hello, Statically fetched show</h1>
      <p>Paths /1 and /2 prerendered; other paths not found</p>
      <dl>
        <dt>Param</dt>
        <dd>{params.id}</dd>
        <dt>Time</dt>
        <dd data-testid="date-now">{new Date().toISOString()}</dd>
      </dl>
    </>
  )
}

export async function getStaticPaths() {
  return {
    paths: [{ params: { id: '1' } }, { params: { id: '2' } }],
    fallback: false,
  }
}

export async function getStaticProps({ params }) {
  const res = await fetch(`https://api.tvmaze.com/shows/${params.id}`)
  const data = await res.json()

  return {
    props: {
      params,
      data,
    },
  }
}
