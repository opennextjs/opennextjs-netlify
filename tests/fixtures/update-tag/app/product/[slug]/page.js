import { unstable_cache } from 'next/cache'

const Product = async ({ params }) => {
  const { slug } = await params

  // using unstable_cache here to add custom tags without using fetch
  const getData = unstable_cache(
    async () => {
      return {
        slug,
        timestamp: new Date().toISOString(),
      }
    },
    [slug],
    {
      tags: [slug],
    },
  )

  const data = await getData()

  // add artificial delay to test that background revalidation is not interrupted
  await new Promise((resolve) => setTimeout(resolve, 5000))

  return (
    <div>
      <h1>Product {decodeURIComponent(slug)}</h1>
      <p>
        This page uses generateStaticParams() to prerender a Product
        <span data-testid="date-now">{new Date().toISOString()}</span>
      </p>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  )
}

export async function generateStaticParams() {
  return [
    {
      // Japanese prerendered (non-ascii) and comma
      slug: '事前レンダリング,test',
    },
  ]
}

export const dynamic = 'force-static'

export default Product
