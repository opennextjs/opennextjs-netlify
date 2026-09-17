export const dynamic = 'force-dynamic'

export default async function Target({ params, searchParams }) {
  const { code } = await params
  const { ref } = await searchParams
  return (
    <main>
      <h1>Internal prefix target</h1>
      <p data-testid="details">
        code={code} ref={ref}
      </p>
    </main>
  )
}
