export default function Page({ message }) {
  return (
    <main>
      <h1>Message from middleware: {message}</h1>
    </main>
  )
}

/** @type {import('next').GetServerSideProps} */
export const getServerSideProps = async (ctx) => {
  return {
    props: {
      message: ctx.req.headers['x-hello-from-middleware-req'] || null,
    },
  }
}
