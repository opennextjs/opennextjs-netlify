import { getDeployStore } from '@netlify/blobs'

const Content = ({ value }) => (
  <div>
    <p>
      <span>{JSON.stringify(value)}</span>
    </p>
  </div>
)

export async function getStaticProps() {
  const store = getDeployStore({ name: 'cms-content', consistency: 'strong' })
  const BLOB_KEY = 'key'

  const value = await store.get(BLOB_KEY, { type: 'json' })

  if (!value) {
    return {
      notFound: true,
    }
  }

  return {
    props: {
      value: value,
    },
  }
}

export const getStaticPaths = () => {
  return {
    paths: [],
    fallback: 'blocking', // false or "blocking"
  }
}

export default Content
