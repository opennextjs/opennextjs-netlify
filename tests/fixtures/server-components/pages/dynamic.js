export default function Yar({ title }) {
  return <h1>{title}</h1>
}

export async function getServerSideProps() {
  return {
    props: {
      title: 'My Page',
    },
  }
}
