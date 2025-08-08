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
let nextRuntimePacked = false
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
  private _setupStartTime = Date.now()
  private _intervalsToClear: NodeJS.Timeout[] = []

  public get buildId() {
    // get deployment ID via fetch since we can't access
    // build artifacts directly
    return this._buildId
  }

  private packNextRuntime() {
    if (!packNextRuntimePromise) {
      if (!nextRuntimePacked) {
        this._deployOutput += this.getTimestampPrefix() + 'Pack Next Runtime ...\n'
      }
      packNextRuntimePromise = packNextRuntimeImpl()
      packNextRuntimePromise.then(() => {
        nextRuntimePacked = true
      })
      if (!nextRuntimePacked) {
        this._deployOutput += this.getTimestampPrefix() + 'Pack Next Runtime DONE\n'
      }
    }

    return packNextRuntimePromise
  }

  private clearIntervals() {
    for (const interval of this._intervalsToClear) {
      clearInterval(interval)
    }
    this._intervalsToClear = []
  }

  private getTimestampPrefix() {
    return `[${new Date().toISOString()}] (+${((Date.now() - this._setupStartTime) / 1000).toFixed(3)}s) `
  }

  private ps(pid) {
    const netlifyStatusPromise = execa('ps', ['-p', pid])

    netlifyStatusPromise.stdout.on('data', this.handleOutput.bind(this))
    netlifyStatusPromise.stderr.on('data', this.handleOutput.bind(this))
  }

  private handleOutput(chunk) {
    const timestampPrefix = this.getTimestampPrefix()

    this._deployOutput +=
      (this._deployOutput === '' || this._deployOutput.endsWith('\n') ? timestampPrefix : '') +
      chunk.toString().replace(/\n(?=.)/gm, `\n${timestampPrefix}`)
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

    this._deployOutput += this.getTimestampPrefix() + 'Setting up test dir ...\n'
    // create the test site
    await super.createTestDir({ parentSpan, skipInstall: true })
    this._deployOutput += this.getTimestampPrefix() + 'Setting up test dir DONE\n'

    // If the test fixture has node modules we need to move them aside then merge them in after

    const nodeModules = path.join(this.testDir, 'node_modules')
    const nodeModulesBak = `${nodeModules}.bak`

    if (fs.existsSync(nodeModules)) {
      this._deployOutput += this.getTimestampPrefix() + 'Rename node_modules ...\n'
      await fs.rename(nodeModules, nodeModulesBak)
      this._deployOutput += this.getTimestampPrefix() + 'Rename node_modules DONE\n'
    }

    const { runtimePackageName, runtimePackageTarballPath } = await this.packNextRuntime()

    // install dependencies
    this._deployOutput += this.getTimestampPrefix() + 'Install dependencies ...\n'
    const installResPromise = execa('npm', ['i', runtimePackageTarballPath, '--legacy-peer-deps'], {
      cwd: this.testDir,
    })

    installResPromise.stdout.on('data', this.handleOutput.bind(this))
    installResPromise.stderr.on('data', this.handleOutput.bind(this))

    await installResPromise
    this._deployOutput += this.getTimestampPrefix() + 'Install dependencies DONE\n'

    if (fs.existsSync(nodeModulesBak)) {
      // move the contents of the fixture node_modules into the installed modules
      this._deployOutput += this.getTimestampPrefix() + 'Move fixture node_modules ...\n'
      for (const file of await fs.readdir(nodeModulesBak)) {
        await fs.move(path.join(nodeModulesBak, file), path.join(nodeModules, file), {
          overwrite: true,
        })
      }
      this._deployOutput += this.getTimestampPrefix() + 'Move fixture node_modules DONE\n'
    }

    // use next runtime package installed by the test runner
    if (!fs.existsSync(path.join(this.testDir, 'netlify.toml'))) {
      const toml = /* toml */ `
          [build]
          command = "npm run build"
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
      const netlifyStatusPromise = execa('npx', ['netlify', 'status', '--json'])

      netlifyStatusPromise.stdout.on('data', this.handleOutput.bind(this))
      netlifyStatusPromise.stderr.on('data', this.handleOutput.bind(this))

      await netlifyStatusPromise
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

    this._deployOutput +=
      this.getTimestampPrefix() + `Started deploy, PID: ${deployResPromise.pid}\n`
    require('console').log(`Started deploy, PID: ${deployResPromise.pid}`)

    deployResPromise.stdout.on('data', this.handleOutput.bind(this))
    deployResPromise.stderr.on('data', this.handleOutput.bind(this))

    deployResPromise.on('error', (err) => {
      this._deployOutput += this.getTimestampPrefix() + `Error during deployment: ${err.message}\n`
      require('console').error(`Error during deployment: ${err.message}`)
    })

    deployResPromise.on('spawn', (err) => {
      this._deployOutput += this.getTimestampPrefix() + `Process spawned\n`
      require('console').error(`Process spawned`)
    })

    deployResPromise.on('disconnect', (err) => {
      this._deployOutput += this.getTimestampPrefix() + `Process disconnected\n`
      require('console').error(`Process disconnected`)
    })

    deployResPromise.on('close', (code, signal) => {
      this._deployOutput +=
        this.getTimestampPrefix() + `Process closed with code: ${code} / signal: ${signal}\n`
      require('console').error(`Process closed with code: ${code} / signal: ${signal}`)
    })

    deployResPromise.on('exit', (code, signal) => {
      this._deployOutput +=
        this.getTimestampPrefix() + `Process exited with code: ${code} / signal: ${signal}\n`
      require('console').error(`Process exited with code: ${code} / signal: ${signal}`)
    })

    this._intervalsToClear.push(
      setInterval(() => {
        this._deployOutput +=
          this.getTimestampPrefix() +
          `Waiting for netlify deploy process to finish ... (killed: ${deployResPromise.killed}, connected: ${deployResPromise.connected})\n`
      }, 5000),
    )

    this._intervalsToClear.push(
      setInterval(() => {
        this.ps(deployResPromise.pid)
      }, 30_000),
    )

    deployResPromise
      .then((result) => {
        require('console').log(`Netlify deploy process finished.`)
        this._deployOutput += this.getTimestampPrefix() + 'Netlify deploy process finished.\n'
      })
      .catch((err) => {
        require('console').log(`Netlify deploy process failed. ` + err)
        this._deployOutput += this.getTimestampPrefix() + 'Netlify deploy process failed. ' + err
      })
      .finally(() => {
        require('console').log(`Netlify deploy process finally.`)
        this._deployOutput += this.getTimestampPrefix() + 'Netlify deploy process finally.\n'
        this.clearIntervals()
      })

    const deployRes = await deployResPromise

    this.clearIntervals()

    require('console').log(`Deploy finished. Processing output...`)

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
      throw new Error(`Failed to parse deploy output: "${deployRes.stdout}"`)
    }

    this._buildId = (
      await fs.readFile(
        path.join(this.testDir, this.nextConfig?.distDir || '.next', 'BUILD_ID'),
        'utf8',
      )
    ).trim()

    require('console').log(`Got buildId: ${this._buildId}`)
    require('console').log(`Setup time: ${(Date.now() - this._setupStartTime) / 1000.0}s`)

    this._isCurrentlyDeploying = false
  }

  public async destroy(): Promise<void> {
    this.clearIntervals()
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
