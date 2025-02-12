// @ts-check
// this installs and builds all the fixtures
// Needed to run before executing the integration tests
import { existsSync, readdirSync } from 'node:fs'
import { rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { argv } from 'node:process'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'
import { execaCommand } from 'execa'
import glob from 'fast-glob'
import pLimit from 'p-limit'
import { setNextVersionInFixture } from './utils/next-version-helpers.mjs'

const NEXT_VERSION = process.env.NEXT_VERSION ?? 'latest'

const fixturesDir = fileURLToPath(new URL(`./fixtures`, import.meta.url))
const fixtureFilter = argv[2] ?? ''

// E2E tests run next builds, so we don't need to prepare those ahead of time for integration tests
const e2eOnlyFixtures = new Set([
  'after',
  'cli-before-regional-blobs-support',
  'dist-dir',
  // There is also a bug on Windows on Node.js 18.20.6, that cause build failures on this fixture
  // see https://github.com/opennextjs/opennextjs-netlify/actions/runs/13268839161/job/37043172448?pr=2749#step:12:78
  'middleware-og',
  'middleware-single-matcher',
  'nx-integrated',
  'turborepo',
  'turborepo-npm',
  'unstable-cache',
])

const limit = pLimit(Math.max(2, cpus().length / 2))
const fixtures = readdirSync(fixturesDir)
  // Ignoring things like `.DS_Store`.
  .filter((fixture) => !fixture.startsWith('.'))
  // Applying the filter, if one is set.
  .filter((fixture) => !fixtureFilter || fixture.startsWith(fixtureFilter))
  // Filter out fixtures that are only needed for E2E tests
  .filter((fixture) => !e2eOnlyFixtures.has(fixture))

console.log(`🧪 Preparing fixtures: ${fixtures.join(', ')}`)
const fixtureList = new Set(fixtures)
const fixtureCount = fixtures.length
const promises = fixtures.map((fixture) =>
  limit(async () => {
    console.log(`[${fixture}] Preparing fixture`)
    const cwd = join(fixturesDir, fixture)
    const publishDirectories = await glob(['**/.next', '**/.turbo'], {
      onlyDirectories: true,
      cwd,
      absolute: true,
    })
    await Promise.all(publishDirectories.map((dir) => rm(dir, { recursive: true, force: true })))

    if (NEXT_VERSION !== 'latest') {
      await setNextVersionInFixture(cwd, NEXT_VERSION, {
        logPrefix: `[${fixture}] `,
      })
    }

    let cmd = ``
    const { packageManager } = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
    if (packageManager?.startsWith('pnpm')) {
      // We disable frozen-lockfile because we may have changed the version of Next.js
      cmd = `pnpm install --frozen-lockfile=false ${
        process.env.DEBUG || NEXT_VERSION !== 'latest' ? '' : '--reporter silent'
      }`
    } else {
      // npm is the default
      cmd = `npm install --no-audit --progress=false --prefer-offline --legacy-peer-deps`
      await rm(join(cwd, 'package-lock.json'), { force: true })
    }

    const addPrefix = new Transform({
      transform(chunk, encoding, callback) {
        this.push(chunk.toString().replace(/\n/gm, `\n[${fixture}] `))
        callback()
      },
      flush(callback) {
        // final transform might create non-terminated line with a prefix
        // so this is just to make sure we end with a newline so further writes
        // to same destination stream start on a new line for better readability
        this.push('\n')
        callback()
      },
    })

    console.log(`[${fixture}] Running \`${cmd}\`...`)
    const output = execaCommand(cmd, {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, FORCE_COLOR: '1' },
    })
    if (process.env.DEBUG) {
      output.stdout?.pipe(addPrefix).pipe(process.stdout)
    }
    output.stderr?.pipe(addPrefix).pipe(process.stderr)
    return output.finally(async () => {
      if (NEXT_VERSION !== 'latest') {
        await setNextVersionInFixture(cwd, 'latest', {
          logPrefix: `[${fixture}] `,
          operation: 'revert',
        })
      }
      if (output.exitCode !== 0) {
        const errorMessage = `[${fixture}] 🚨 Failed to install dependencies or build a fixture`
        console.error(errorMessage)
        throw new Error(errorMessage)
      }
      fixtureList.delete(fixture)
    })
  }).finally(() => {
    console.log(
      `[${fixture}] Done. ${limit.pendingCount + limit.activeCount}/${fixtureCount} remaining.`,
    )
    if (limit.activeCount < 5 && limit.activeCount > 0) {
      console.log(`[${fixture}] Waiting for ${Array.from(fixtureList).join(', ')}`)
    }
  }),
)
const prepareFixturesResults = await Promise.allSettled(promises)
const failedFixturesErrors = prepareFixturesResults
  .map((promise) => {
    if (promise.status === 'rejected') {
      return promise.reason
    }
    return null
  })
  .filter(Boolean)

if (failedFixturesErrors.length > 0) {
  console.error('Some fixtures failed to prepare:')
  for (const error of failedFixturesErrors) {
    console.error(error.message)
  }
  process.exit(1)
}

console.log('🎉 All fixtures prepared')
