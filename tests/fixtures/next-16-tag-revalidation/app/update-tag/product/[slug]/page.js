import { unstable_cache, updateTag } from 'next/cache'

const Product = async ({ params }) => {
  const { slug } = await params

  const tag = `update-tag-${slug}`

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
      <form>
        <button
          data-testid="update-tag-button"
          formAction={async () => {
            'use server'
            updateTag(tag)
          }}
        >
          Update Tag
        </button>
      </form>
    </div>
  )
}

export async function generateStaticParams() {
  return [
    {
      slug: 'prerendered',
    },
  ]
}

export const dynamic = 'force-static'

export default Product
