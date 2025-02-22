import type { GetStaticPaths, GetStaticProps } from 'next'

export default function CatchAll({ params, locale }) {
  return <pre>{JSON.stringify({ params, locale }, null, 2)}</pre>
}

export const getStaticPaths: GetStaticPaths = () => {
  return {
    paths: [],
    fallback: 'blocking',
  }
}

export const getStaticProps: GetStaticProps = ({ params, locale }) => {
  return {
    props: {
      params,
      locale,
    },
  }
}
