export default function Page({ params }) {
  return (
    <>
      <h1>Hello, Dyanmically fetched show</h1>
      <dl>
        <dt>Param</dt>
        <dd>{params.id}</dd>
        <dt>Time</dt>
        <dd data-testid="date-now">{new Date().toISOString()}</dd>
      </dl>
    </>
  )
}

export async function getServerSideProps({ params }) {
  const res = await fetch(`https://api.tvmaze.com/shows/${params.id}`)
  const data = await res.json()

  return {
    props: {
      params,
      data,
    },
  }
}
