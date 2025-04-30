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
  'use cache'
  cacheTag(`component/${props.route}`)
  cacheLife('5seconds')
  return <ResultComponentImplementation {...props} />
}

export default async function PageComponent({ params }: BasePageComponentProps) {
  return (
    <PageComponentImplementation
      routeRoot="default/use-cache-component/dynamic/ttl-5seconds"
      params={params}
      getData={getData}
      ResultWrapperComponent={ResultWrapperComponent}
    />
  )
}

export const dynamic = 'force-dynamic'
