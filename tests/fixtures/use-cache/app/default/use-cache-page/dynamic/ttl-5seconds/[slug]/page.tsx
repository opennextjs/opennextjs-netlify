import { cacheLife, cacheTag } from '../../../../../next-cache'
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
  const routeRoot = 'default/use-cache-page/dynamic/ttl-5seconds'
  cacheTag(`page/${routeRoot}/${(await params).slug}`)
  cacheLife('5seconds')

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
