const Product = ({ time, slug }) => (
  <div>
    <h1>Product {slug}</h1>
    <p>
      This page uses getStaticProps() and getStaticPaths() to pre-fetch a Product
      <span data-testid="date-now">{time}</span>
    </p>
  </div>
)

/** @type {import('next').GetStaticProps} */
export async function getStaticProps({ params }) {
  if (params.slug === 'not-found-no-revalidate') {
    return {
      notFound: true,
    }
  } else if (params.slug === 'not-found-with-revalidate') {
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

/** @type {import('next').GetStaticPaths} */
export const getStaticPaths = ({ locales }) => {
  return {
    paths: [
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
    ].flatMap((pathDescription) => locales.map((locale) => ({ ...pathDescription, locale }))),
    fallback: 'blocking', // false or "blocking"
  }
}

export default Product
