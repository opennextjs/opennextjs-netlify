export default async function Page({ params }) {
  const { slug } = await params
  return (
    <main>
      <h1>Slotted {slug}</h1>
    </main>
  )
}
