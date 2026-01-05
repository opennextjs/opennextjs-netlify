import { tmpdir } from 'os'
import { join } from 'path'

import execa from 'execa'
import { mkdtempSync, copySync } from 'fs-extra'
import fetch from 'node-fetch'
import waitOn from 'wait-on'

let destroy = () => {}

const slugify = (str: string) => str.replace('@', '').replace(/\//g, '-')

beforeAll(
  async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), `isolated-test-`))

    // copy fixture to isolated tmp directory
    const siteSrcDir = join(__dirname, 'fixtures', 'next-package-not-resolvable-in-base-dir')
    const siteDestDir = join(tmpDir, 'next-package-not-resolvable-in-base-dir')

    console.log(`copying fixture site "${siteSrcDir}" to "${siteDestDir}"`)
    copySync(siteSrcDir, siteDestDir)

    // bump version so no npm cache tries to use what's in npm registry
    const runtimeSrcDir = join(__dirname, '..', '..', 'packages', 'runtime')
    await execa(`npm`, [`version`, `prerelease`, `--no-git-tag-version`], { cwd: runtimeSrcDir, stdio: `inherit` })

    // create package tarball
    const o = await execa(`npm`, [`pack`, `--json`], { cwd: runtimeSrcDir })
    const tgzName = slugify(JSON.parse(o.stdout)[0].filename)
    const tgzPath = join(runtimeSrcDir, tgzName)

    // install runtime from tarball
    await execa(`npm`, [`install`, tgzPath], { cwd: siteDestDir, stdio: `inherit` })

    return new Promise<void>(async (resolve, reject) => {
      try {
        // run
        let isServeRunning = true
        const serveProcess = execa('netlify', ['serve', `-p`, `8888`], { cwd: siteDestDir, stdio: `inherit` })

        let shouldRejectOnNonZeroProcessExit = true
        serveProcess.catch((error) => {
          isServeRunning = false
          if (shouldRejectOnNonZeroProcessExit) {
            reject(error)
          }
          return null
        })

        await waitOn({
          resources: [`http://localhost:8888/`],
          timeout: 3 * 60 * 1000,
        })

        if (!isServeRunning) {
          return reject(new Error(`serve process exited`))
        }

        destroy = () => {
          shouldRejectOnNonZeroProcessExit = false
          serveProcess.kill()
        }

        // ensure we can't resolve "next" from either base dir or app dir
        // this is done to ensure that functions packaging worked correctly and doesn't rely on
        // leftover node_modules that wouldn't be available when functions are deployed to lambdas
        expect(() => require.resolve(`next`, { paths: [siteDestDir] })).toThrow()
        expect(() => require.resolve(`next`, { paths: [join(siteDestDir, `next-app`)] })).toThrow()

        return resolve()
      } catch (error) {
        reject(error)
      }
    })
  },
  3 * 60 * 1000,
)

afterAll(() => destroy())

it(`page route executes correctly`, async () => {
  const htmlResponse = await fetch(`http://localhost:8888/`)
  // ensure we got a 200
  expect(htmlResponse.ok).toBe(true)
  // ensure we use ssr handler
  expect(htmlResponse.headers.get(`x-nf-render-mode`)).toEqual(`ssr`)
  const t = expect(await htmlResponse.text()).toMatch(/Hello world/)
})

it(`api route executes correctly`, async () => {
  const apiResponse = await fetch(`http://localhost:8888/api/hello`)
  // ensure we got a 200
  expect(apiResponse.ok).toBe(true)
  expect(await apiResponse.json()).toEqual({ name: 'John Doe' })
})
