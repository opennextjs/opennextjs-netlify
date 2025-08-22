import { Module, createRequire } from 'node:module'
import vm from 'node:vm'
import { join, dirname } from 'node:path/posix'
import { fileURLToPath, pathToFileURL } from 'node:url'

type RegisteredModule = {
  source: string
  loaded: boolean
  filepath: string
  // lazily parsed json string
  parsedJson?: any
}
const registeredModules = new Map<string, RegisteredModule>()

const require = createRequire(import.meta.url)

let hookedIn = false

function parseJson(matchedModule: RegisteredModule) {
  if (matchedModule.parsedJson) {
    return matchedModule.parsedJson
  }

  try {
    const jsonContent = JSON.parse(matchedModule.source)
    matchedModule.parsedJson = jsonContent
    return jsonContent
  } catch (error) {
    throw new Error(`Failed to parse JSON module: ${matchedModule.filepath}`, { cause: error })
  }
}

function seedCJSModuleCacheAndReturnTarget(matchedModule: RegisteredModule, parent: Module) {
  if (matchedModule.loaded) {
    return matchedModule.filepath
  }
  const { source, filepath } = matchedModule

  const mod = new Module(filepath)
  mod.parent = parent
  mod.filename = filepath
  mod.path = dirname(filepath)
  // @ts-expect-error - private untyped API
  mod.paths = Module._nodeModulePaths(mod.path)
  require.cache[filepath] = mod

  try {
    if (filepath.endsWith('.json')) {
      Object.assign(mod.exports, parseJson(matchedModule))
    } else {
      const wrappedSource = `(function (exports, require, module, __filename, __dirname) { ${source}\n});`
      const compiled = vm.runInThisContext(wrappedSource, {
        filename: filepath,
        lineOffset: 0,
        displayErrors: true,
      })
      const modRequire = createRequire(pathToFileURL(filepath))
      compiled(mod.exports, modRequire, mod, filepath, dirname(filepath))
    }
    mod.loaded = matchedModule.loaded = true
  } catch (error) {
    throw new Error(`Failed to compile CJS module: ${filepath}`, { cause: error })
  }

  return filepath
}

// ideally require.extensions could be used, but it does NOT include '.cjs', so hardcoding instead
const exts = ['.js', '.cjs', '.json']

function tryWithExtensions(filename: string) {
  let matchedModule = registeredModules.get(filename)
  if (!matchedModule) {
    for (const ext of exts) {
      // require("./test") might resolve to ./test.js
      const targetWithExt = filename + ext

      matchedModule = registeredModules.get(targetWithExt)
      if (matchedModule) {
        break
      }
    }
  }

  return matchedModule
}

function tryMatchingWithIndex(target: string) {
  let matchedModule = tryWithExtensions(target)
  if (!matchedModule) {
    // require("./test") might resolve to ./test/index.js
    const indexTarget = join(target, 'index')
    matchedModule = tryWithExtensions(indexTarget)
  }

  return matchedModule
}

export function registerCJSModules(baseUrl: URL, modules: Map<string, string>) {
  const basePath = dirname(fileURLToPath(baseUrl))

  for (const [filename, source] of modules.entries()) {
    const target = join(basePath, filename)

    registeredModules.set(target, { source, loaded: false, filepath: target })
  }

  if (!hookedIn) {
    // @ts-expect-error - private untyped API
    const original_resolveFilename = Module._resolveFilename.bind(Module)
    // @ts-expect-error - private untyped API
    Module._resolveFilename = (...args) => {
      let target = args[0]
      let isRelative = args?.[0].startsWith('.')

      if (isRelative) {
        // only handle relative require paths
        const requireFrom = args?.[1]?.filename

        target = join(dirname(requireFrom), args[0])
      }

      let matchedModule = tryMatchingWithIndex(target)

      if (!isRelative && !target.startsWith('/')) {
        const packageName = target.startsWith('@')
          ? target.split('/').slice(0, 2).join('/')
          : target.split('/')[0]
        const moduleInPackagePath = target.slice(packageName.length + 1)

        for (const nodeModulePaths of args[1].paths) {
          const potentialPackageJson = join(nodeModulePaths, packageName, 'package.json')

          const maybePackageJson = registeredModules.get(potentialPackageJson)

          let relativeTarget = moduleInPackagePath

          let pkgJson: any = null
          if (maybePackageJson) {
            pkgJson = parseJson(maybePackageJson)

            // TODO: exports and anything else like that
            if (moduleInPackagePath.length === 0 && pkgJson.main) {
              relativeTarget = pkgJson.main
            }
          }

          const potentialPath = join(nodeModulePaths, packageName, relativeTarget)

          matchedModule = tryMatchingWithIndex(potentialPath)
          if (matchedModule) {
            break
          }
        }
      }

      if (matchedModule) {
        return seedCJSModuleCacheAndReturnTarget(matchedModule, args[1])
      }

      return original_resolveFilename(...args)
    }

    hookedIn = true
  }
}
