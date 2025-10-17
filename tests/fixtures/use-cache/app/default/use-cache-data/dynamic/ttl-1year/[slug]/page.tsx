import { cacheLife, cacheTag } from '../../../../../next-cache'
import {
  BasePageComponentProps,
  getDataImplementation,
  PageComponentImplementation,
  ResultComponentImplementation,
  ResultWrapperComponentProps,
} from '../../../../../helpers'

async function getData(route: string) {
  'use cache'
  cacheTag(`data/${route}`)
  cacheLife('1year')

  return await getDataImplementation(route)
}

async function ResultWrapperComponent(props: ResultWrapperComponentProps) {
  return <ResultComponentImplementation {...props} />
}

export default async function PageComponent({ params }: BasePageComponentProps) {
  return (
    <PageComponentImplementation
      routeRoot="default/use-cache-data/dynamic/ttl-1year"
      params={params}
      getData={getData}
      ResultWrapperComponent={ResultWrapperComponent}
    />
  )
}

export const dynamic = 'force-dynamic'
