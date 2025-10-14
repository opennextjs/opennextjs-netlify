export default async function Page({ params }) {
  const { slug } = await params

  return (
    <>
      <h1>
        Skew Protection Testing - <code>next.config.js</code> - link target page
      </h1>
      <p>
        Current variant:{' '}
        <span data-testid="linked-page-current-variant">{process.env.SKEW_VARIANT}</span>
      </p>
      <p>
        Slug: <span data-testid="linked-page-slug">{slug}</span>
      </p>
    </>
  )
}
