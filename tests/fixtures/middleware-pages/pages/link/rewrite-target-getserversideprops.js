export default function Page() {
  return (
    <div data-page="NextResponse.rewrite()#getServerSideProps">
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
