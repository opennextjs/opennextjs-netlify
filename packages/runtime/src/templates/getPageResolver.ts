import glob from 'globby'
import { outdent } from 'outdent'
import { join, relative, resolve } from 'pathe'

import { HANDLER_FUNCTION_NAME } from '../constants'
import { getDependenciesOfFile } from '../helpers/files'

// Generate a file full of require.resolve() calls for all the pages in the
// build. This is used by the nft bundler to find all the pages.

export const getUniqueDependencies = async (sourceFiles: Array<string>) => {
  const dependencies = await Promise.all(sourceFiles.map((sourceFile) => getDependenciesOfFile(sourceFile)))
  return [...new Set([...sourceFiles, ...dependencies.flat()])].sort()
}

export const getAllPageDependencies = async (publish: string) => {
  const root = resolve(publish, 'server')

  const pageFiles = await glob('{pages,app}/**/*.js', {
    cwd: root,
    dot: true,
  })
  // We don't use `absolute: true` because that returns Windows paths on Windows.
  // Instead we use pathe to normalize the paths.
  return getUniqueDependencies(pageFiles.map((pageFile) => join(root, pageFile)))
}

export const getResolverForDependencies = ({
  dependencies,
  functionDir,
}: {
  dependencies: string[]
  functionDir: string
}) => {
  const pageFiles = dependencies.map((file) => `require.resolve('${relative(functionDir, file)}')`)
  return outdent /* javascript */ `
    // This file is purely to allow nft to know about these pages.
    exports.resolvePages = () => {
        try {
            ${pageFiles.sort().join('\n        ')}
        } catch {}
    }
  `
}

export const getResolverForPages = async (publish: string, packagePath: string) => {
  const functionDir = resolve(packagePath, '.netlify', 'functions', HANDLER_FUNCTION_NAME)
  const dependencies = await getAllPageDependencies(publish)
  return getResolverForDependencies({ dependencies, functionDir })
}

export const getResolverForSourceFiles = async ({
  functionsDir,
  sourceFiles,
}: {
  functionsDir: string
  sourceFiles: Array<string>
}) => {
  // We don't need the actual name, just the relative path.
  const functionDir = resolve(functionsDir, 'functionName')
  const dependencies = await getUniqueDependencies(sourceFiles)
  return getResolverForDependencies({ dependencies, functionDir })
}
