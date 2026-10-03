export const dynamicParams = false

export const generateStaticParams = async () => {
  return [{ slug: 'prerendered' }]
}

export default async function Page({ params }) {
  const { slug } = await params
  return (
    <main>
      <h1>Grouped {slug}</h1>
    </main>
  )
}
