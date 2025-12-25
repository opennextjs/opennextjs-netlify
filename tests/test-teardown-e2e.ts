import { globalE2EFixtureTeardown } from './utils/create-e2e-fixture'

export default async () => {
  console.log('teardown')
  await globalE2EFixtureTeardown()
}
