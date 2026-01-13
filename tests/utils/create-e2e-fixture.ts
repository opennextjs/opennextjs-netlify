import AdmZip from 'adm-zip'
import { execaCommand } from 'execa'
import fg from 'fast-glob'
import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { cpus } from 'os'
import pLimit from 'p-limit'
import { setNextVersionInFixture } from './next-version-helpers.mjs'

// https://app.netlify.com/sites/next-runtime-testing
const DEFAULT_SITE_ID = 'ee859ce9-44a7-46be-830b-ead85e445e53'
export const SITE_ID = process.env.NETLIFY_SITE_ID ?? DEFAULT_SITE_ID
const NEXT_VERSION = process.env.NEXT_VERSION || 'latest'
const NETLIFY_DEPLOY_ALIAS = 'next-e2e-tests'

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
  /**
   * If set to true, instead of using CLI to deploy, we will zip the source files and trigger build from zip.
   */
  useBuildbot?: boolean
  /**
   * Runs before deploying the site if defined.
   */
  onPreDeploy?: (isolatedFixtureRoot: string) => Promise<void>
  /**
   * Buildbot mode specific callback that will be called once the build starts.
   * Useful for scenario of triggering multiple consecutive builds, to be able to schedule builds
   * before previous one finish completely. If multiple builds are scheduled at the same time, some
   * of them might be skipped and this callback allows to avoid this scenario.
   */
  onBuildStart?: () => Promise<void> | void
  /**
   * Environment variables that will be added to `netlify.toml` if set.
   */
  env?: Record<string, string>
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
    // on failures we don't delete the deploy, but we do cleanup the fixture from filesystem in CI
    if (process.env.CI) {
      return cleanup(isolatedFixtureRoot, undefined)
    }
  }
  try {
    const [packageName] = await Promise.all([
      buildAndPackRuntime(config, isolatedFixtureRoot),
      copyFixture(fixture, isolatedFixtureRoot, config),
    ])

    await setNextVersionInFixture(isolatedFixtureRoot, NEXT_VERSION)
    await installRuntime(packageName, isolatedFixtureRoot, config)
    await verifyFixture(isolatedFixtureRoot, config)
    await config.onPreDeploy?.(isolatedFixtureRoot)

    const deploySite = config.useBuildbot ? deploySiteWithBuildbot : deploySiteWithCLI

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
${
  config.env
    ? `[build.environment]\n${Object.entries(config.env)
        .map(([key, value]) => `${key} = "${value}"`)
        .join('\n')}`
    : ''
}

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

  let relativePathToPackage = relative(
    join(isolatedFixtureRoot, siteRelDir),
    join(isolatedFixtureRoot, packageName),
  )
  if (!relativePathToPackage.startsWith('.')) {
    relativePathToPackage = `./${relativePathToPackage}`
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
      command = `pnpm add file:${relativePathToPackage} ${
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

export async function deploySiteWithCLI(
  isolatedFixtureRoot: string,
  { packagePath, cwd = '', siteId = SITE_ID }: E2EConfig,
): Promise<DeployResult> {
  console.log(`🚀 Building and deploying site...`)

  const outputFile = 'deploy-output.txt'
  let cmd = `npx netlify deploy --site ${siteId} --alias ${NETLIFY_DEPLOY_ALIAS}`

  if (packagePath) {
    cmd += ` --filter ${packagePath}`
  }

  const siteDir = join(isolatedFixtureRoot, cwd)
  await execaCommand(cmd, { cwd: siteDir, all: true }).pipeAll?.(join(siteDir, outputFile))
  const output = await readFile(join(siteDir, outputFile), 'utf-8')

  const { siteName, deployID } =
    new RegExp(
      /app\.netlify\.com\/(sites|projects)\/(?<siteName>[^\/]+)\/deploys\/(?<deployID>[0-9a-f]+)/gm,
    ).exec(output)?.groups || {}

  if (!deployID) {
    throw new Error('Could not extract DeployID from the build logs')
  }

  return {
    url: `https://${deployID}--${siteName}.netlify.app`,
    deployID,
    logs: output,
  }
}

export async function deploySiteWithBuildbot(
  isolatedFixtureRoot: string,
  { packagePath, siteId = SITE_ID, publishDirectory = '.next', onBuildStart }: E2EConfig,
): Promise<DeployResult> {
  if (packagePath) {
    // It's likely possible to support this, just skipping implementing it until there's a need
    // throwing just to be explicit that this was not done to avoid potential confusion if things
    // don't work
    throw new Error('packagePath is not currently supported when deploying with buildbot')
  }

  if (!process.env.NETLIFY_AUTH_TOKEN) {
    // we use CLI (ntl api) for most of operations, but build zip upload seems impossible with CLI
    // and we do need to use API directly and we do need token for that
    throw new Error('NETLIFY_AUTH_TOKEN is required for buildbot deploy, but it was not set')
  }

  console.log(`🚀 Packing source files and triggering deploy`)

  const newZip = new AdmZip()
  newZip.addLocalFolder(isolatedFixtureRoot, '', (entry) => {
    if (
      // don't include node_modules / .git / publish dir in zip
      entry.includes('node_modules') ||
      entry.includes('.git') ||
      entry.startsWith(publishDirectory)
    ) {
      return false
    }
    return true
  })

  const result = await fetch(
    `https://api.netlify.com/api/v1/sites/${siteId}/builds?clear_cache=true`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,
      },
      // @ts-expect-error sigh, it works
      body: newZip.toBuffer(),
    },
  )
  const { deploy_id } = await result.json()

  let didRunOnBuildStartCallback = false
  const runOnBuildStartCallbackOnce = onBuildStart
    ? () => {
        if (!didRunOnBuildStartCallback) {
          didRunOnBuildStartCallback = true
          return onBuildStart()
        }
      }
    : () => {}

  // poll for status
  while (true) {
    const { stdout } = await execaCommand(
      `npx netlify api getDeploy --data=${JSON.stringify({ deploy_id })}`,
    )
    const { state } = JSON.parse(stdout)

    if (state === 'error' || state === 'rejected') {
      await runOnBuildStartCallbackOnce()
      throw new Error(
        `The deploy failed https://app.netlify.com/projects/${siteId}/deploys/${deploy_id}`,
      )
    }
    if (state === 'ready') {
      await runOnBuildStartCallbackOnce()
      break
    }

    if (state === 'building') {
      await runOnBuildStartCallbackOnce()
    }

    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  return {
    deployID: deploy_id,
    url: `https://${deploy_id}--${siteId}.netlify.app`, // this is not nice, but it does work
    logs: '',
  }
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

export function getBuildFixtureVariantCommand(variantName: string) {
  return `node ${fileURLToPath(new URL(`./build-variants.mjs`, import.meta.url))} ${variantName}`
}

export async function createSite(siteConfig?: { name: string }) {
  const cmd = `npx netlify api createSiteInTeam --data=${JSON.stringify({
    account_slug: 'netlify-integration-testing',
    body: siteConfig ?? {},
  })}`

  const { stdout } = await execaCommand(cmd)
  const { site_id, ssl_url, admin_url } = JSON.parse(stdout)

  console.log(`🚀 Created site ${ssl_url} / ${admin_url}`)

  return {
    siteId: site_id as string,
    url: ssl_url as string,
    adminUrl: admin_url as string,
  }
}

export async function deleteSite(siteId: string) {
  const cmd = `npx netlify api deleteSite --data=${JSON.stringify({ site_id: siteId })}`
  await execaCommand(cmd)
}

export async function publishDeploy(siteId: string, deployID: string) {
  const cmd = `npx netlify api restoreSiteDeploy --data=${JSON.stringify({ site_id: siteId, deploy_id: deployID })}`
  await execaCommand(cmd)
}

export const fixtureFactories = {
  simple: () => createE2EFixture('simple'),
  helloWorldTurbopack: () =>
    createE2EFixture('hello-world-turbopack', {
      buildCommand: 'next build --turbopack',
    }),
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
  middlewareNode: () =>
    createE2EFixture('middleware', {
      buildCommand: getBuildFixtureVariantCommand('node-middleware'),
      publishDirectory: '.next-node-middleware',
    }),
  middlewareNodeRuntimeSpecific: () => createE2EFixture('middleware-node-runtime-specific'),
  middlewareNodeRuntimeSpecificPnpm: () =>
    createE2EFixture('middleware-node-runtime-specific', {
      packageManger: 'pnpm',
    }),
  middlewareI18n: () => createE2EFixture('middleware-i18n'),
  middlewareI18nNode: () =>
    createE2EFixture('middleware-i18n', {
      buildCommand: getBuildFixtureVariantCommand('node-middleware'),
      publishDirectory: '.next-node-middleware',
    }),
  middlewareI18nExcludedPaths: () => createE2EFixture('middleware-i18n-excluded-paths'),
  middlewareI18nExcludedPathsNode: () =>
    createE2EFixture('middleware-i18n-excluded-paths', {
      buildCommand: getBuildFixtureVariantCommand('node-middleware'),
      publishDirectory: '.next-node-middleware',
    }),
  middlewareOg: () => createE2EFixture('middleware-og'),
  middlewarePages: () => createE2EFixture('middleware-pages'),
  middlewarePagesNode: () =>
    createE2EFixture('middleware-pages', {
      buildCommand: getBuildFixtureVariantCommand('node-middleware'),
      publishDirectory: '.next-node-middleware',
    }),
  middlewareStaticAssetMatcher: () => createE2EFixture('middleware-static-asset-matcher'),
  middlewareStaticAssetMatcherNode: () =>
    createE2EFixture('middleware-static-asset-matcher', {
      buildCommand: getBuildFixtureVariantCommand('node-middleware'),
      publishDirectory: '.next-node-middleware',
    }),
  middlewareSubrequestVuln: () => createE2EFixture('middleware-subrequest-vuln'),
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
  next16TagRevalidation: () => createE2EFixture('next-16-tag-revalidation'),
  nxIntegrated: () =>
    createE2EFixture('nx-integrated', {
      packagePath: 'apps/next-app',
      buildCommand: 'nx run next-app:build',
      publishDirectory: 'dist/apps/next-app/.next',
      env: {
        NX_ISOLATE_PLUGINS: 'false',
      },
    }),
  nxIntegratedDistDir: () =>
    createE2EFixture('nx-integrated', {
      packagePath: 'apps/custom-dist-dir',
      buildCommand: 'nx run custom-dist-dir:build',
      publishDirectory: 'dist/apps/custom-dist-dir/dist',
      env: {
        NX_ISOLATE_PLUGINS: 'false',
      },
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
  npmMonorepoProxy: () =>
    createE2EFixture('npm-monorepo-proxy', {
      buildCommand: 'npm run build --workspace @apps/site',
      packagePath: 'apps/site',
      publishDirectory: 'apps/site/.next',
      smoke: true,
    }),
  pnpmMonorepoBaseProxy: () =>
    createE2EFixture('pnpm-monorepo-base-proxy', {
      buildCommand: 'pnpm run build',
      generateNetlifyToml: false,
      packageManger: 'pnpm',
      publishDirectory: '.next',
      runtimeInstallationPath: 'app',
      smoke: true,
      useBuildbot: true,
    }),
  dynamicCms: () => createE2EFixture('dynamic-cms'),
  after: () => createE2EFixture('after'),
}
