export default function Page() {
  return (
    <div data-page="NextResponse.next()#getStaticProps">
      <h1>
        <code>getStaticProps</code> page
      </h1>
    </div>
  )
}

export function getStaticProps() {
  return {
    props: {},
  }
}
