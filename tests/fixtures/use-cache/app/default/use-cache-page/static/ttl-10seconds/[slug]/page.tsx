import { unstable_cacheLife as cacheLife, unstable_cacheTag as cacheTag } from 'next/cache'
import {
  BasePageComponentProps,
  generateStaticParamsImplementation,
  getDataImplementation,
  PageComponentImplementation,
  ResultComponentImplementation,
  ResultWrapperComponentProps,
} from '../../../../../helpers'

async function getData(route: string) {
  return await getDataImplementation(route)
}

async function ResultWrapperComponent(props: ResultWrapperComponentProps) {
  return <ResultComponentImplementation {...props} />
}

export default async function PageComponent({ params }: BasePageComponentProps) {
  'use cache'
  const routeRoot = 'default/use-cache-page/static/ttl-10seconds'
  cacheTag(`page/${routeRoot}/${(await params).slug}`)
  cacheLife('10seconds') // longer TTL than page revalidate to test interaction
  return (
    <PageComponentImplementation
      routeRoot={routeRoot}
      params={params}
      getData={getData}
      ResultWrapperComponent={ResultWrapperComponent}
    />
  )
}

export function generateStaticParams() {
  return generateStaticParamsImplementation()
}

export const revalidate = 5
export const dynamic = 'force-static'
