import { unstable_cacheLife as cacheLife, unstable_cacheTag as cacheTag } from 'next/cache'
import {
  BasePageComponentProps,
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
  const routeRoot = 'default/use-cache-page/dynamic/ttl-1year'
  cacheTag(`page/${routeRoot}/${(await params).slug}`)
  cacheLife('1year')

  return (
    <PageComponentImplementation
      routeRoot={routeRoot}
      params={params}
      getData={getData}
      ResultWrapperComponent={ResultWrapperComponent}
    />
  )
}

export const dynamic = 'force-dynamic'
