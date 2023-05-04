import Head from 'next/head'

export default function Home() {
  return (
    <>
      <Head>
        <title>Create Next App</title>
        <meta name="description" content="Generated by create next app" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <main>
        <div>Hello world</div>
      </main>
    </>
  )
}

export const getServerSideProps = async ({ params }) => {
  return {
    props: {
      ssr: true,
    },
  }
}