import { cacheLife, cacheTag } from '../../../../../next-cache'
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
  const routeRoot = 'default/use-cache-page/static/ttl-1year'
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

export function generateStaticParams() {
  return generateStaticParamsImplementation()
}

export const dynamic = 'force-static'
