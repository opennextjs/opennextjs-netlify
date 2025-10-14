import { unstable_cache } from 'next/cache'

const slug = 'product-static'
const tag = `revalidate-tag-string-profile-${slug}`

const Product = async () => {
  // using unstable_cache here to add custom tags without using fetch
  const getData = unstable_cache(
    async () => {
      // add artificial delay to test that background revalidation is not interrupted
      await new Promise((resolve) => setTimeout(resolve, 5000))
      return {
        slug,
        timestamp: new Date().toISOString(),
      }
    },
    [slug],
    {
      tags: [tag],
    },
  )

  const data = await getData()

  return (
    <div>
      <h1>Product {decodeURIComponent(slug)}</h1>
      <code data-testid="date-now">{data.timestamp}</code>
    </div>
  )
}

export const dynamic = 'force-static'

export default Product
