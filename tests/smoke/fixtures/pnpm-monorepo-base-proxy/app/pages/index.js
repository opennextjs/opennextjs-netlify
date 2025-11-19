export default function Home({ ssr }) {
  return (
    <main>
      <div data-testid="smoke">SSR: {ssr ? 'yes' : 'no'}</div>
    </main>
  )
}

export const getServerSideProps = async () => {
  return {
    props: {
      ssr: true,
    },
  }
}
