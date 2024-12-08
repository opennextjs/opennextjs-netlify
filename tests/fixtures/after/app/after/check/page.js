export const revalidate = 3600 // arbitrarily long, just so that it doesn't happen during a test run

export default async function Page() {
  const data = {
    timestamp: Date.now(),
  }
  console.log('/timestamp/key/[key] rendered', data)

  return <div id="page-info">{JSON.stringify(data)}</div>
}
