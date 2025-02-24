const Product = ({ time, slug }) => (
  <div>
    <h1>Product {slug}</h1>
    <p>
      This page uses getStaticProps() and getStaticPaths() to pre-fetch a Product
      <span data-testid="date-now">{time}</span>
    </p>
  </div>
)

export async function getStaticProps({ params }) {
  if (params.slug === 'not-found-with-revalidate') {
    return {
      notFound: true,
      revalidate: 600,
    }
  }

  return {
    props: {
      time: new Date().toISOString(),
      slug: params.slug,
    },
  }
}

export const getStaticPaths = () => {
  return {
    paths: [
      {
        params: {
          slug: 'an-incredibly-long-product-name-thats-impressively-repetetively-needlessly-overdimensioned-and-should-be-shortened-to-less-than-255-characters-for-the-sake-of-seo-and-ux-and-first-and-foremost-for-gods-sake-but-nobody-wont-ever-read-this-anyway',
        },
      },
      {
        params: {
          slug: 'prerendered',
        },
      },
      {
        params: {
          // Japanese prerendered (non-ascii) and comma
          slug: '事前レンダリング,test',
        },
      },
    ],
    fallback: 'blocking', // false or "blocking"
  }
}

export default Product
