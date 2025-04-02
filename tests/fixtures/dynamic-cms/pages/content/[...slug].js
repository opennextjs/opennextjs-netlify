import { getDeployStore } from '@netlify/blobs'

const Content = ({ value }) => (
  <div>
    <p>
      <span>{JSON.stringify(value)}</span>
    </p>
  </div>
)

export async function getStaticProps({ params }) {
  const contentKey = params.slug.join('/')

  const store = getDeployStore({ name: 'cms-content', consistency: 'strong' })

  const value = await store.get(contentKey, { type: 'json' })

  if (!value) {
    return {
      notFound: true,
    }
  }

  return {
    props: {
      value,
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
