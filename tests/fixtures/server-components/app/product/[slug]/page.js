const Product = async ({ params }) => {
  const { slug } = await params
  return (
    <div>
      <h1>Product {decodeURIComponent(slug)}</h1>
      <p>
        This page uses generateStaticParams() to prerender a Product
        <span data-testid="date-now">{new Date().toISOString()}</span>
      </p>
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
