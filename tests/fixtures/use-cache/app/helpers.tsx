export type Data = {
  data: string
  time: string
}

export async function getDataImplementation(route: string): Promise<Data> {
  const res = await fetch(`https://strangerthings-quotes.vercel.app/api/quotes`)
  return {
    data: (await res.json())[0].quote,
    time: new Date().toISOString(),
  }
}

export type ResultWrapperComponentProps = {
  route: string
  children: React.ReactNode
}

export async function ResultComponentImplementation({
  route,
  children,
}: ResultWrapperComponentProps) {
  return (
    <>
      {children}
      <dt>Time (GetDataResult)</dt>
      <dd data-testid="ResultWrapperComponent-time">{new Date().toISOString()}</dd>
    </>
  )
}

export type BasePageComponentProps = {
  params: Promise<{ slug: string }>
}

export async function PageComponentImplementation({
  getData,
  ResultWrapperComponent,
  params,
  routeRoot,
}: BasePageComponentProps & {
  routeRoot: string
  getData: typeof getDataImplementation
  ResultWrapperComponent: typeof ResultComponentImplementation
}) {
  const { slug } = await params
  const route = `${routeRoot}/${slug}`
  const { data, time } = await getData(route)

  return (
    <>
      <h1>Hello, use-cache - {route}</h1>
      <dl>
        <ResultWrapperComponent route={route}>
          <dt>Quote (getData)</dt>
          <dd data-testid="getData-data">{data}</dd>
          <dt>Time (getData)</dt>
          <dd data-testid="getData-time">{time}</dd>
        </ResultWrapperComponent>
        <dt>Time (PageComponent)</dt>
        <dd data-testid="PageComponent-time">{new Date().toISOString()}</dd>
      </dl>
    </>
  )
}

export function generateStaticParamsImplementation() {
  return [
    {
      slug: 'prerendered',
    },
  ]
}
