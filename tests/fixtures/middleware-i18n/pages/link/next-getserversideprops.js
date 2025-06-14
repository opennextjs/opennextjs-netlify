export default function Page() {
  return (
    <div data-page="NextResponse.next()#getServerSideProps">
      <h1>
        <code>getServerSideProps</code> page
      </h1>
    </div>
  )
}

export function getServerSideProps() {
  return {
    props: {},
  }
}
