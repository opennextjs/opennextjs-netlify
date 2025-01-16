import { getDeployStore } from '@netlify/blobs'

const Show = ({ slug }) => {
  // ensure that the content is stable to trigger 304 responses
  return <pre>{slug}</pre>
}

/** @type {import('next').getStaticPaths} */
export async function getStaticPaths() {
  return {
    paths: [],
    fallback: 'blocking',
  }
}

/** @type {import('next').GetStaticProps} */
export async function getStaticProps({ params }) {
  const store = getDeployStore({ name: 'get-static-props-tracker', consistency: 'strong' })

  const start = Date.now()

  console.log(`[timestamp] ${params.slug} getStaticProps start`)

  const storeStartPromise = store.set(`${params.slug}-start`, start).then(() => {
    console.log(`[timestamp] ${params.slug} getStaticProps start stored`)
  })

  // simulate a long running operation
  await new Promise((resolve) => setTimeout(resolve, 5000))

  const storeEndPromise = store.set(`${params.slug}-end`, Date.now()).then(() => {
    console.log(`[timestamp] ${params.slug} getStaticProps end stored`)
  })

  console.log(
    `[timestamp] ${params.slug} getStaticProps end (duration: ${(Date.now() - start) / 1000}s)`,
  )

  await Promise.all([storeStartPromise, storeEndPromise])

  // ensure that the data is stable and always the same to trigger 304 responses
  return {
    props: {
      slug: params.slug,
    },
    revalidate: 5,
  }
}

export default Show
