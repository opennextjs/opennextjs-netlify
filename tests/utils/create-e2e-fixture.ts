import { execaCommand } from 'execa'
import fg from 'fast-glob'
import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { cpus } from 'os'
import pLimit from 'p-limit'
import { setNextVersionInFixture } from './next-version-helpers.mjs'

// https://app.netlify.com/sites/next-runtime-testing
const DEFAULT_SITE_ID = 'ee859ce9-44a7-46be-830b-ead85e445e53'
export const SITE_ID = process.env.NETLIFY_SITE_ID ?? DEFAULT_SITE_ID
const NEXT_VERSION = process.env.NEXT_VERSION || 'latest'

export interface DeployResult {
  deployID: string
  url: string
  logs: string
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'berry'

interface E2EConfig {
  packageManger?: PackageManager
  packagePath?: string
  cwd?: string
  buildCommand?: string
  publishDirectory?: string
  smoke?: boolean
  generateNetlifyToml?: false
  /**
   * If runtime should be installed in a custom location and not in cwd / packagePath
   */
  runtimeInstallationPath?: string
  /**
   * Some fixtures might pin to non-latest CLI versions. This is used to verify the used CLI version matches expected one
   */
  expectedCliVersion?: string
  /**
   * Site ID to deploy to. Defaults to the `NETLIFY_SITE_ID` environment variable or a default site.
   */
  siteId?: string
}

/**
 * Copies a fixture to a temp folder on the system and runs the tests inside.
 * @param fixture name of the folder inside the fixtures folder
 */
export const createE2EFixture = async (fixture: string, config: E2EConfig = {}) => {
  const isolatedFixtureRoot = await mkdtemp(join(tmpdir(), 'opennextjs-netlify-'))
  let deployID: string
  let logs: string
  const _cleanup = (failure: boolean = false) => {
    if (process.env.E2E_PERSIST) {
      console.log(
        `💾 Fixture and deployed site have been persisted. To clean up automatically, run tests without the 'E2E_PERSIST' environment variable.`,
      )

      return
    }

    if (!failure) {
      return cleanup(isolatedFixtureRoot, deployID)
    }
    console.log('\n\n\n🪵  Deploy logs:')
    console.log(logs)
    // on failures we don't delete the deploy
  }
  try {
    const [packageName] = await Promise.all([
      buildAndPackRuntime(config, isolatedFixtureRoot),
      copyFixture(fixture, isolatedFixtureRoot, config),
    ])

    if (NEXT_VERSION !== 'latest') {
      await setNextVersionInFixture(isolatedFixtureRoot, NEXT_VERSION)
    }
    await installRuntime(packageName, isolatedFixtureRoot, config)
    await verifyFixture(isolatedFixtureRoot, config)

    const result = await deploySite(isolatedFixtureRoot, config)

    console.log(`🌍 Deployed site is live: ${result.url}`)
    deployID = result.deployID
    logs = result.logs
    return {
      cleanup: _cleanup,
      deployID: result.deployID,
      url: result.url,
    }
  } catch (error) {
    await _cleanup(true)
    throw error
  }
}

export type Fixture = Awaited<ReturnType<typeof createE2EFixture>>

/** Copies a fixture folder to a destination */
async function copyFixture(
  fixtureName: string,
  isolatedFixtureRoot: string,
  config: E2EConfig,
): Promise<void> {
  console.log(`📂 Copying fixture '${fixtureName}' to '${isolatedFixtureRoot}'...`)

  const src = fileURLToPath(
    new URL(`../${config.smoke ? `smoke/fixtures` : `fixtures`}/${fixtureName}`, import.meta.url),
  )
  const files = await fg.glob('**/*', {
    ignore: ['node_modules', '.yarn'],
    dot: true,
    cwd: src,
  })

  const limit = pLimit(Math.max(2, cpus().length))
  await Promise.all(
    files.map((file) =>
      limit(async () => {
        await mkdir(join(isolatedFixtureRoot, dirname(file)), { recursive: true })
        await copyFile(join(src, file), join(isolatedFixtureRoot, file))
      }),
    ),
  )

  await execaCommand('git init', { cwd: isolatedFixtureRoot })
}

/** Creates a tarball of the packed npm package at the provided destination */
async function buildAndPackRuntime(
  config: E2EConfig,
  isolatedFixtureRoot: string,
): Promise<string> {
  const {
    packagePath,
    cwd,
    buildCommand = 'next build',
    publishDirectory,
    generateNetlifyToml,
  } = config
  console.log(`📦 Creating tarball with 'npm pack'...`)

  const siteRelDir = cwd ?? packagePath ?? ''

  const { stdout } = await execaCommand(
    // for the e2e tests we don't need to clean up the package.json. That just creates issues with concurrency
    `npm pack --json --ignore-scripts --pack-destination ${isolatedFixtureRoot}`,
  )
  const [{ filename, name }] = JSON.parse(stdout)

  if (generateNetlifyToml !== false) {
    await appendFile(
      join(join(isolatedFixtureRoot, siteRelDir), 'netlify.toml'),
      `[build]
command = "${buildCommand}"
publish = "${publishDirectory ?? join(siteRelDir, '.next')}"

[[plugins]]
package = "${name}"
`,
    )
  }

  return filename
}

async function installRuntime(
  packageName: string,
  isolatedFixtureRoot: string,
  { packageManger = 'npm', packagePath, cwd, runtimeInstallationPath }: E2EConfig,
): Promise<void> {
  console.log(`🐣 Installing runtime from '${packageName}'...`)

  const siteRelDir = runtimeInstallationPath ?? cwd ?? packagePath ?? ''

  let workspaceRelPath: string | undefined
  let workspaceName: string | undefined
  // only add the workspace if a package.json exits in the packagePath
  // some monorepos like nx don't have a package.json in the app folder
  if (siteRelDir && existsSync(join(isolatedFixtureRoot, siteRelDir, 'package.json'))) {
    workspaceRelPath = siteRelDir
    workspaceName = JSON.parse(
      await readFile(join(isolatedFixtureRoot, siteRelDir, 'package.json'), 'utf-8'),
    ).name
  }

  let command: string | undefined

  let env = {} as NodeJS.ProcessEnv

  if (packageManger !== 'npm') {
    await rm(join(isolatedFixtureRoot, 'package-lock.json'), { force: true })
  }

  switch (packageManger) {
    case 'npm':
      command = `npm install --ignore-scripts --no-audit --legacy-peer-deps ${packageName} ${
        workspaceRelPath ? `-w ${workspaceRelPath}` : ''
      }`
      break
    case 'yarn':
      command = `yarn ${workspaceName ? `workspace ${workspaceName}` : '-W'} add file:${join(
        isolatedFixtureRoot,
        packageName,
      )} --ignore-scripts`
      break
    case 'berry':
      command = `yarn ${workspaceName ? `workspace ${workspaceName}` : ''} add ${join(
        isolatedFixtureRoot,
        packageName,
      )}`
      env['YARN_ENABLE_SCRIPTS'] = 'false'
      break
    case 'pnpm':
      command = `pnpm add file:${join(isolatedFixtureRoot, packageName)} ${
        workspaceRelPath ? `--filter ./${workspaceRelPath}` : ''
      } --ignore-scripts`
      break
    case 'bun':
      command = `bun install ./${packageName}`
      break
    default:
      throw new Error(`Unsupported package manager: ${packageManger}`)
  }

  console.log(`📦 Running install command '${command}'...`)

  await execaCommand(command, { cwd: isolatedFixtureRoot, env })

  if (packageManger === 'npm' && workspaceRelPath) {
    // installing package in npm workspace doesn't install root level packages, so we additionally install those
    await execaCommand('npm install --ignore-scripts --no-audit', { cwd: isolatedFixtureRoot })
  }
}

async function verifyFixture(isolatedFixtureRoot: string, { expectedCliVersion }: E2EConfig) {
  if (expectedCliVersion) {
    const { stdout } = await execaCommand('npx netlify --version', { cwd: isolatedFixtureRoot })

    const match = stdout.match(/netlify-cli\/(?<version>\S+)/)

    if (!match) {
      throw new Error(`Could not extract the Netlify CLI version from the build logs`)
    }

    const extractedVersion = match.groups?.version

    if (!extractedVersion) {
      throw new Error(`Could not extract the Netlify CLI version from the build logs`)
    }

    if (extractedVersion !== expectedCliVersion) {
      throw new Error(
        `Using unexpected CLI version "${extractedVersion}". Expected "${expectedCliVersion}"`,
      )
    }
  }
}

async function deploySite(
  isolatedFixtureRoot: string,
  { packagePath, cwd = '', siteId = SITE_ID }: E2EConfig,
): Promise<DeployResult> {
  console.log(`🚀 Building and deploying site...`)

  const outputFile = 'deploy-output.txt'
  let cmd = `npx netlify deploy --build --site ${siteId}`

  if (packagePath) {
    cmd += ` --filter ${packagePath}`
  }

  const siteDir = join(isolatedFixtureRoot, cwd)
  await execaCommand(cmd, { cwd: siteDir, all: true }).pipeAll?.(join(siteDir, outputFile))
  const output = await readFile(join(siteDir, outputFile), 'utf-8')

  const [url] = new RegExp(/https:.+\.netlify\.app/gm).exec(output) || []
  if (!url) {
    throw new Error('Could not extract the URL from the build logs')
  }
  const [deployID] = new URL(url).host.split('--')
  return { url, deployID, logs: output }
}

export async function deleteDeploy(deployID?: string): Promise<void> {
  if (!deployID) {
    return
  }

  const cmd = `npx netlify api deleteDeploy --data='{"deploy_id":"${deployID}"}'`
  // execa mangles around with the json so let's use exec here
  return new Promise<void>((resolve, reject) => exec(cmd, (err) => (err ? reject(err) : resolve())))
}

async function cleanup(dest: string, deployId?: string): Promise<void> {
  console.log(`🧹 Cleaning up fixture and deployed site...`)
  console.log(
    `  - To persist them for further inspection, run the tests with the 'E2E_PERSIST' environment variable`,
  )

  await Promise.allSettled([deleteDeploy(deployId), rm(dest, { recursive: true, force: true })])
}

export const fixtureFactories = {
  simple: () => createE2EFixture('simple'),
  outputExport: () => createE2EFixture('output-export'),
  ouputExportPublishOut: () =>
    createE2EFixture('output-export', {
      publishDirectory: 'out',
    }),
  outputExportCustomDist: () =>
    createE2EFixture('output-export-custom-dist', {
      publishDirectory: 'custom-dist',
    }),
  distDir: () =>
    createE2EFixture('dist-dir', {
      publishDirectory: 'cool/output',
    }),
  yarn: () => createE2EFixture('simple', { packageManger: 'yarn' }),
  pnpm: () => createE2EFixture('pnpm', { packageManger: 'pnpm' }),
  bun: () => createE2EFixture('simple', { packageManger: 'bun' }),
  middleware: () => createE2EFixture('middleware'),
  middlewareOg: () => createE2EFixture('middleware-og'),
  middlewarePages: () => createE2EFixture('middleware-pages'),
  pageRouter: () => createE2EFixture('page-router'),
  pageRouterBasePathI18n: () => createE2EFixture('page-router-base-path-i18n'),
  turborepo: () =>
    createE2EFixture('turborepo', {
      packageManger: 'pnpm',
      packagePath: 'apps/page-router',
      buildCommand: 'turbo build --filter page-router',
    }),
  turborepoNPM: () =>
    createE2EFixture('turborepo-npm', {
      packageManger: 'npm',
      packagePath: 'apps/page-router',
      buildCommand: 'turbo build --filter page-router',
    }),
  serverComponents: () => createE2EFixture('server-components'),
  nxIntegrated: () =>
    createE2EFixture('nx-integrated', {
      packageManger: 'pnpm',
      packagePath: 'apps/next-app',
      buildCommand: 'nx run next-app:build',
      publishDirectory: 'dist/apps/next-app/.next',
    }),
  nxIntegratedDistDir: () =>
    createE2EFixture('nx-integrated', {
      packageManger: 'pnpm',
      packagePath: 'apps/custom-dist-dir',
      buildCommand: 'nx run custom-dist-dir:build',
      publishDirectory: 'dist/apps/custom-dist-dir/dist',
    }),
  cliBeforeRegionalBlobsSupport: () =>
    createE2EFixture('cli-before-regional-blobs-support', {
      expectedCliVersion: '17.21.1',
    }),
  yarnMonorepoWithPnpmLinker: () =>
    createE2EFixture('yarn-monorepo-with-pnpm-linker', {
      packageManger: 'berry',
      packagePath: 'apps/site',
      buildCommand: 'yarn build',
      publishDirectory: 'apps/site/.next',
      smoke: true,
      runtimeInstallationPath: '',
    }),
  npmMonorepoEmptyBaseNoPackagePath: () =>
    createE2EFixture('npm-monorepo-empty-base', {
      cwd: 'apps/site',
      buildCommand: 'npm run build',
      publishDirectory: 'apps/site/.next',
      smoke: true,
      generateNetlifyToml: false,
    }),
  npmMonorepoSiteCreatedAtBuild: () =>
    createE2EFixture('npm-monorepo-site-created-at-build', {
      buildCommand: 'npm run build',
      publishDirectory: 'apps/site/.next',
      smoke: true,
      generateNetlifyToml: false,
    }),
  next12_0_3: () =>
    createE2EFixture('next-12.0.3', {
      buildCommand: 'npm run build',
      publishDirectory: '.next',
      smoke: true,
    }),
  next12_1_0: () =>
    createE2EFixture('next-12.1.0', {
      buildCommand: 'npm run build',
      publishDirectory: '.next',
      smoke: true,
    }),
  yarnMonorepoMultipleNextVersionsSiteCompatible: () =>
    createE2EFixture('yarn-monorepo-multiple-next-versions-site-compatible', {
      buildCommand: 'npm run build',
      publishDirectory: 'apps/site/.next',
      packagePath: 'apps/site',
      // install runtime in root to make sure we correctly resolve next version from
      // the site location
      runtimeInstallationPath: '',
      packageManger: 'yarn',
      smoke: true,
    }),
  yarnMonorepoMultipleNextVersionsSiteIncompatible: () =>
    createE2EFixture('yarn-monorepo-multiple-next-versions-site-incompatible', {
      buildCommand: 'npm run build',
      publishDirectory: 'apps/site/.next',
      packagePath: 'apps/site',
      // install runtime in root to make sure we correctly resolve next version from
      // the site location
      runtimeInstallationPath: '',
      packageManger: 'yarn',
      smoke: true,
    }),
  npmNestedSiteMultipleNextVersionsCompatible: () =>
    createE2EFixture('npm-nested-site-multiple-next-version-site-compatible', {
      buildCommand: 'cd apps/site && npm install && npm run build',
      publishDirectory: 'apps/site/.next',
      smoke: true,
    }),
  npmNestedSiteMultipleNextVersionsIncompatible: () =>
    createE2EFixture('npm-nested-site-multiple-next-version-site-incompatible', {
      buildCommand: 'cd apps/site && npm install && npm run build',
      publishDirectory: 'apps/site/.next',
      smoke: true,
    }),
  after: () => createE2EFixture('after'),
}
