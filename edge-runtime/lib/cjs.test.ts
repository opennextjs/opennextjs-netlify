import { createRequire } from 'node:module'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertEquals } from 'https://deno.land/std@0.175.0/testing/asserts.ts'

import { registerCJSModules } from './cjs.ts'

type RequireResult = Record<string, string>

const localRequire = createRequire(import.meta.url)
const realRequireResult = localRequire('./fixture/cjs/entry.js') as RequireResult

const fixtureRoot = new URL('./fixture/cjs/', import.meta.url)
const virtualRoot = new URL('file:///virtual-root/index.mjs')

const fixtureRootPath = fileURLToPath(fixtureRoot)
const virtualRootPath = dirname(fileURLToPath(virtualRoot))

// load fixture into virtual CJS
const virtualModules = new Map<string, string>()
const virtualLinks = new Map<string, string>()
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
    } else if (dirEntry.isSymlink) {
      const target = await Deno.readLink(new URL('./' + dirEntry.name, dirUrl))
      virtualLinks.set(relPath, target)
    }
  }
}

await addVirtualModulesFromDir('')
registerCJSModules(virtualRoot, virtualModules, virtualLinks)

const virtualRequire = createRequire(virtualRoot)
const virtualRequireResult = virtualRequire('./entry.js') as RequireResult

const expectedVirtualRequireResult = {
  entry: '/virtual-root/entry.js',

  packageExportsConditionsExportedModule:
    '/virtual-root/node_modules/package-exports-conditions/dist/exported-module.js',
  packageExportsConditionsRoot:
    '/virtual-root/node_modules/package-exports-conditions/root-export.js',
  packageExportsConditionsWildcardModuleNoExt:
    '/virtual-root/node_modules/package-exports-conditions/dist/wildcard/module.js',
  packageExportsConditionsWildcardModuleWithExt:
    '/virtual-root/node_modules/package-exports-conditions/dist/wildcard/module.js',
  packageExportsExportedModule:
    '/virtual-root/node_modules/package-exports/dist/exported-module.js',
  packageExportsMainRoot: '/virtual-root/node_modules/package-exports-main/root-export.js',
  packageExportsNotAllowedBecauseNotInExportMap: 'ERROR',
  packageExportsRoot: '/virtual-root/node_modules/package-exports/root-export.js',
  packageExportsSugarRoot: '/virtual-root/node_modules/package-exports-sugar/root-export.js',
  packageExportsWildcardModuleNoExt:
    '/virtual-root/node_modules/package-exports/dist/wildcard/module.js',
  packageExportsWildcardModuleWithExt:
    '/virtual-root/node_modules/package-exports/dist/wildcard/module.js',
  packageRoot: '/virtual-root/node_modules/package/index.js',
  packageInternalModule: '/virtual-root/node_modules/package/internal-module.js',
  packageMainRoot: '/virtual-root/node_modules/package-main/main.js',
  packageMainInternalModule: '/virtual-root/node_modules/package-main/internal-module.js',
  packageWithNestedPackageJsons:
    '/virtual-root/node_modules/package-with-nested-package-jsons/dist/compiled/nested/main.js',
  pnpmPackageExportsExportedModule:
    '/virtual-root/node_modules/.pnpm/pnpm-package-exports@0.0.0/dist/exported-module.js',
  pnpmPackageExportsNotAllowedBecauseNotInExportMap: 'ERROR',
  pnpmPackageExportsRoot:
    '/virtual-root/node_modules/.pnpm/pnpm-package-exports@0.0.0/root-export.js',
  pnpmPackageExportsWildcardModuleNoExt:
    '/virtual-root/node_modules/.pnpm/pnpm-package-exports@0.0.0/dist/wildcard/module.js',
  pnpmPackageExportsWildcardModuleWithExt:
    '/virtual-root/node_modules/.pnpm/pnpm-package-exports@0.0.0/dist/wildcard/module.js',
} as RequireResult

Deno.test('Virtual CJS Module loader matches real CJS Module loader', async (t) => {
  // make sure we collect all the possible keys to spot any cases of potentially missing keys in one of the objects
  const allTheKeys = [
    ...new Set([
      ...Object.keys(expectedVirtualRequireResult),
      ...Object.keys(realRequireResult),
      ...Object.keys(virtualRequireResult),
    ]),
  ]

  function normalizeValue(value: string, basePath: string) {
    if (value === 'ERROR') {
      return value
    }

    return relative(basePath, value)
  }

  for (const key of allTheKeys) {
    const virtualValue = virtualRequireResult[key]
    const realValue = realRequireResult[key]

    // values are filepaths or "ERROR" strings, "real" require has actual file system paths, virtual ones has virtual paths starting with file:///virtual-root/
    // we compare remaining paths to ensure same relative paths are reported indicating that resolution works the same in
    // in real CommonJS and simulated one
    assertEquals(
      normalizeValue(realValue, fixtureRootPath),
      normalizeValue(virtualValue, virtualRootPath),
    )
  }
})

Deno.test('Virtual CJS Module loader matches expected results', async (t) => {
  // the main portion of testing functionality is in above assertions that compare real require and virtual one
  // below is additional explicit assertion mostly to make sure that test setup is correct
  assertEquals(virtualRequireResult, expectedVirtualRequireResult)
})
