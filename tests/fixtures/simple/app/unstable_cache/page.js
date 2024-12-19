import { unstable_cache } from 'next/cache'

export const dynamic = 'force-dynamic'

const getData = unstable_cache(
  async () => {
    return {
      timestamp: Date.now(),
    }
  },
  [],
  {
    revalidate: 1,
  },
)

export default async function Page() {
  const data = await getData()

  return <pre>{JSON.stringify(data, null, 2)}</pre>
}
