import { execaCommand } from 'execa'
import { globalE2EFixtureSetup } from './utils/create-e2e-fixture'

// build the runtime before running tests
export default async () => {
  console.log(`🔨 Building runtime...`, process.cwd())
  await execaCommand('npm run build')

  await globalE2EFixtureSetup()
}
