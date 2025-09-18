export default function Page() {
  return (
    <>
      <h1>Skew Protection Testing - Pages Router - fully static page</h1>
      <p>
        Current variant:{' '}
        <span data-testid="linked-static-current-variant">{process.env.SKEW_VARIANT}</span>
      </p>
    </>
  )
}
