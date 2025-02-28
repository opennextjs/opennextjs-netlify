const Show = ({ time, easyTimeToCompare, slug }) => (
  <div>
    <p>
      This page uses getStaticProps() at
      <span data-testid="date-now">{time}</span>
    </p>
    <p>
      Time string: <span data-testid="date-easy-time">{easyTimeToCompare}</span>
    </p>
    <p>Slug {slug}</p>
  </div>
)

/** @type {import('next').getStaticPaths} */
export const getStaticPaths = () => {
  return {
    paths: [],
    fallback: 'blocking',
  }
}

/** @type {import('next').GetStaticProps} */
export async function getStaticProps({ params }) {
  const date = new Date()
  return {
    props: {
      slug: params.slug,
      time: date.toISOString(),
      easyTimeToCompare: date.toTimeString(),
    },
    revalidate: 60,
  }
}

export default Show
