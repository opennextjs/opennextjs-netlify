import { createRequire } from 'node:module'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertEquals } from 'https://deno.land/std@0.175.0/testing/asserts.ts'

import { registerCJSModules } from './cjs.ts'

Deno.test('Virtual CJS Module loader', async (t) => {
  const localRequire = createRequire(import.meta.url)
  const realRequireResult = localRequire('./fixture/cjs/entry.js') as Record<string, string>

  const fixtureRoot = new URL('./fixture/cjs/', import.meta.url)
  const virtualRoot = new URL('file:///virtual-root/index.mjs')

  const fixtureRootPath = fileURLToPath(fixtureRoot)
  const virtualRootPath = dirname(fileURLToPath(virtualRoot))

  // load fixture into virtual CJS
  const virtualModules = new Map<string, string>()
  const decoder = new TextDecoder('utf-8')
  async function addVirtualModulesFromDir(dir: string) {
    const dirUrl = new URL('./' + dir, fixtureRoot)

    for await (const dirEntry of Deno.readDir(dirUrl)) {
      const relPath = join(dir, dirEntry.name)
      if (dirEntry.isDirectory) {
        await addVirtualModulesFromDir(relPath + '/')
      } else if (dirEntry.isFile) {
        const fileURL = new URL('./' + dirEntry.name, dirUrl)
        virtualModules.set(relPath, decoder.decode(await Deno.readFile(fileURL)))
      }
    }
  }

  await addVirtualModulesFromDir('')
  registerCJSModules(virtualRoot, virtualModules)

  const virtualRequire = createRequire(virtualRoot)
  const virtualRequireResult = virtualRequire('./entry.js') as Record<string, string>

  const expectedVirtualRequireResult = {
    entry: '/virtual-root/entry.js',
    packageRoot: '/virtual-root/node_modules/package/index.js',
    packageInternalModule: '/virtual-root/node_modules/package/internal-module.js',
    packageMainRoot: '/virtual-root/node_modules/package-main/not-index.js',
    packageMainInternalModule: '/virtual-root/node_modules/package-main/internal-module.js',
  } as Record<string, string>

  // make sure we collect all the possible keys to spot any cases of potentially missing keys in one of the objects
  const allTheKeys = [
    ...new Set([
      ...Object.keys(expectedVirtualRequireResult),
      ...Object.keys(realRequireResult),
      ...Object.keys(virtualRequireResult),
    ]),
  ]

  for (const key of allTheKeys) {
    const virtualValue = virtualRequireResult[key]
    const realValue = realRequireResult[key]

    // values are filepaths, "real" require has actual file system paths, virtual ones has virtual paths starting with file:///virtual-root/
    // we compare remaining paths to ensure same relative paths are reported indicating that resolution works the same in
    // in real CommonJS and simulated one
    assertEquals(relative(fixtureRootPath, realValue), relative(virtualRootPath, virtualValue))
  }

  // the main portion of testing functionality is in above assertions that compare real require and virtual one
  // below is additional explicit assertion mostly to make sure that test setup is correct
  assertEquals(virtualRequireResult, expectedVirtualRequireResult)
})
