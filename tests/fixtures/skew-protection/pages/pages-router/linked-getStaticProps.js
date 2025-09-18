export default function Page({ variant }) {
  return (
    <>
      <h1>
        Skew Protection Testing - Pages Router - page with <code>getStaticProps</code>
      </h1>
      <p>
        Current variant:{' '}
        <span data-testid="linked-getStaticProps-current-variant">{process.env.SKEW_VARIANT}</span>
      </p>
      <p>
        Variant from props: <span data-testid="linked-getStaticProps-props-variant">{variant}</span>
      </p>
    </>
  )
}

export async function getStaticProps() {
  return {
    props: {
      variant: process.env.SKEW_VARIANT,
    },
  }
}
