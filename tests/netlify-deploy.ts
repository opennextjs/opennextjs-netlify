// This is copied to the Next.js repo
import execa from 'execa'
import fs from 'fs-extra'
import { Span } from 'next/src/trace'
import { tmpdir } from 'node:os'
import path from 'path'
import { NextInstance } from './base'

async function packNextRuntimeImpl() {
  const runtimePackDir = await fs.mkdtemp(path.join(tmpdir(), 'opennextjs-netlify-pack'))

  const { stdout } = await execa(
    'npm',
    ['pack', '--json', '--ignore-scripts', `--pack-destination=${runtimePackDir}`],
    { cwd: process.env.RUNTIME_DIR || `${process.cwd()}/../opennextjs-netlify` },
  )
  const [{ filename, name }] = JSON.parse(stdout)

  return {
    runtimePackageName: name,
    runtimePackageTarballPath: path.join(runtimePackDir, filename),
  }
}

let packNextRuntimePromise: ReturnType<typeof packNextRuntimeImpl> | null = null
function packNextRuntime() {
  if (!packNextRuntimePromise) {
    packNextRuntimePromise = packNextRuntimeImpl()
  }

  return packNextRuntimePromise
}

export class NextDeployInstance extends NextInstance {
  private _cliOutput: string
  private _buildId: string
  private _deployId: string
  private _shouldDeleteDeploy: boolean = false
  private _isCurrentlyDeploying: boolean = false
  private _deployOutput: string = ''

  public get buildId() {
    // get deployment ID via fetch since we can't access
    // build artifacts directly
    return this._buildId
  }

  public async setup(parentSpan: Span) {
    if (process.env.SITE_URL && process.env.BUILD_ID) {
      require('console').log('Using existing deployment: ' + process.env.SITE_URL)
      this._url = process.env.SITE_URL
      this._parsedUrl = new URL(this._url)
      this._buildId = process.env.BUILD_ID
      return
    }

    this._isCurrentlyDeploying = true

    const setupStartTime = Date.now()

    const { runtimePackageName, runtimePackageTarballPath } = await packNextRuntime()

    this.dependencies = {
      ...(this.dependencies || {}),
      // add the runtime package as a dependency
      [runtimePackageName]: `file:${runtimePackageTarballPath}`,
    }

    // create the test site
    await super.createTestDir({
      parentSpan,
      skipInstall: true,
    })

    const nodeModules = path.join(this.testDir, 'node_modules')
    if (fs.existsSync(nodeModules)) {
      require('console').log(`!!! Fixture already has node_modules`)
    }

    // install dependencies
    await execa('pnpm', ['install', '--strict-peer-dependencies=false', '--no-frozen-lockfile'], {
      cwd: this.testDir,
      stdio: 'inherit',
    })

    // use next runtime package installed by the test runner
    if (!fs.existsSync(path.join(this.testDir, 'netlify.toml'))) {
      const toml = /* toml */ `
          [build]
          command = "pnpm run build"
          publish = ".next"

          [build.environment]
          # this allows to use "CanaryOnly" features with next@latest
          NEXT_PRIVATE_TEST_MODE = "e2e"

          [[plugins]]
          package = "${runtimePackageName}"
          `

      await fs.writeFile(path.join(this.testDir, 'netlify.toml'), toml)
    }

    // ensure netlify-cli is installed
    try {
      const res = await execa('npx', ['netlify', '--version'])
      require('console').log(`Using Netlify CLI version:`, res.stdout)
    } catch (_) {
      require('console').log(`netlify-cli is not installed.

      Something went wrong. Try running \`npm install\`.`)
    }

    // ensure project is linked
    try {
      await execa('npx', ['netlify', 'status', '--json'])
    } catch (err) {
      if (err.message.includes("You don't appear to be in a folder that is linked to a site")) {
        throw new Error(`Site is not linked. Please set "NETLIFY_AUTH_TOKEN" and "NETLIFY_SITE_ID"`)
      }
      throw err
    }

    require('console').log(`Deploying project at ${this.testDir}`)

    const testName =
      process.env.TEST_FILE_PATH && path.relative(process.cwd(), process.env.TEST_FILE_PATH)

    const deployTitle = process.env.GITHUB_SHA
      ? `${testName} - ${process.env.GITHUB_SHA}`
      : testName
    const deployAlias = process.env.DEPLOY_ALIAS ?? 'vercel-next-e2e'

    const deployResPromise = execa(
      'npx',
      ['netlify', 'deploy', '--build', '--message', deployTitle ?? '', '--alias', deployAlias],
      {
        cwd: this.testDir,
        reject: false,
      },
    )

    const handleOutput = (chunk) => {
      this._deployOutput += chunk
    }

    deployResPromise.stdout.on('data', handleOutput)
    deployResPromise.stderr.on('data', handleOutput)

    const deployRes = await deployResPromise

    if (deployRes.exitCode !== 0) {
      // clear deploy output to avoid printing it again in destroy()
      this._deployOutput = ''
      throw new Error(
        `Failed to deploy project (${deployRes.exitCode}) ${deployRes.stdout} ${deployRes.stderr} `,
      )
    }

    try {
      const deployUrlRegex = new RegExp(
        /https:\/\/app\.netlify\.com\/(sites|projects)\/(?<siteName>[^\/]+)\/deploys\/(?<deployID>[0-9a-f]+)/gm,
      ).exec(deployRes.stdout)
      const [buildLogsUrl] = deployUrlRegex || []
      const { deployID, siteName } = deployUrlRegex?.groups || {}

      if (!deployID) {
        throw new Error('Could not extract DeployID from the build logs')
      }

      this._url = `https://${deployID}--${siteName}.netlify.app`
      this._parsedUrl = new URL(this._url)
      this._deployId = deployID
      this._shouldDeleteDeploy = !process.env.NEXT_TEST_SKIP_CLEANUP
      this._cliOutput = deployRes.stdout + deployRes.stderr

      require('console').log(`Deployment URL: ${this._url}`)
      if (buildLogsUrl) {
        require('console').log(`Logs: ${buildLogsUrl}`)
      }
    } catch (err) {
      require('console').error(err)
      throw new Error(`Failed to parse deploy output: ${deployRes.stdout}`)
    }

    this._buildId = (
      await fs.readFile(
        path.join(this.testDir, this.nextConfig?.distDir || '.next', 'BUILD_ID'),
        'utf8',
      )
    ).trim()

    require('console').log(`Got buildId: ${this._buildId}`)
    require('console').log(`Setup time: ${(Date.now() - setupStartTime) / 1000.0}s`)

    this._isCurrentlyDeploying = false
  }

  public async destroy(): Promise<void> {
    if (this._shouldDeleteDeploy) {
      require('console').log(`Deleting project with deploy_id ${this._deployId}`)

      const deleteResponse = await execa('npx', [
        'ntl',
        'api',
        'deleteDeploy',
        '--data',
        `{ "deploy_id": "${this._deployId}" }`,
      ])

      if (deleteResponse.exitCode !== 0) {
        require('console').error(
          `Failed to delete deploy ${deleteResponse.stdout} ${deleteResponse.stderr} (${deleteResponse.exitCode})`,
        )
      } else {
        require('console').log(`Successfully deleted deploy with deploy_id ${this._deployId}`)
        this._shouldDeleteDeploy = false
      }
    }

    if (this._isCurrentlyDeploying) {
      require('console').log('Destroying before deployment finished.')
      if (this._deployOutput) {
        require('console').log(`Deploy logs so far:\n\n${this._deployOutput}\n\n`)
      }
    }

    await super.destroy()
  }

  public get cliOutput() {
    return this._cliOutput || ''
  }

  public async start() {
    // no-op as the deployment is created during setup()
  }

  public async patchFile(filename: string, content: string): Promise<void> {
    throw new Error('patchFile is not available in deploy test mode')
  }
  public async readFile(filename: string): Promise<string> {
    throw new Error('readFile is not available in deploy test mode')
  }
  public async deleteFile(filename: string): Promise<void> {
    throw new Error('deleteFile is not available in deploy test mode')
  }
  public async renameFile(filename: string, newFilename: string): Promise<void> {
    throw new Error('renameFile is not available in deploy test mode')
  }
}
