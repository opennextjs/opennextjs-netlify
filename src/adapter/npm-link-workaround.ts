// This is workaround for development of adapters API usage in Next Runtime when using `npm link` to link the package in development.
//
// Some custom modules that can be provided need to be in under the root of Next.js project (for example Image Loader file), and when using `npm link`, the symlinked package is outside of the Next.js project root, which cause Next.js to throw an error. This workaround copies the module to `.netlify/npm-link-workaround/` directory under the Next.js project root and points to that file instead of the original one in the linked package. This way, we can continue developing the adapter API in Next Runtime while using `npm link` without issues.

import { copyFileSync, mkdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

const WORKAROUND_REL_DIR = '.netlify/npm-link-workaround'

// this is intentionally sync function so it works in every context without worrying about async
export const workaroundNpmLinkOutsideOfProjectRoot = (filePath: string) => {
  const cwd = process.cwd()
  if (relative(cwd, filePath).startsWith('..')) {
    const workaroundDir = join(cwd, WORKAROUND_REL_DIR)

    mkdirSync(workaroundDir, { recursive: true })
    // get filename of original filePath, copy it to workaroundDir and return the new path
    const fileName = basename(filePath)
    if (!fileName) {
      throw new Error(`Invalid file path: ${filePath}`)
    }
    const newFilePath = join(workaroundDir, fileName)
    copyFileSync(filePath, newFilePath)
    return newFilePath
  }

  // in this case we don't need to do anything as the file is already under the project root
  return filePath
}
