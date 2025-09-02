import { Module, createRequire } from 'node:module'
import vm from 'node:vm'
import { sep } from 'node:path'
import { join, dirname, sep as posixSep } from 'node:path/posix'
import { fileURLToPath, pathToFileURL } from 'node:url'

const toPosixPath = (path: string) => path.split(sep).join(posixSep)

type RegisteredModule = {
  source: string
  loaded: boolean
  filepath: string
  // lazily parsed json string
  parsedJson?: any
}
type ModuleResolutions = (subpath: string) => string
const registeredModules = new Map<string, RegisteredModule>()
const memoizedPackageResolvers = new WeakMap<RegisteredModule, ModuleResolutions>()

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

type Condition = string // 'import', 'require', 'default', 'node-addon' etc
type SubpathMatcher = string
type ConditionalTarget = { [key in Condition]: string | ConditionalTarget }
type SubpathTarget = string | ConditionalTarget
/**
 * @example
 * {
 *   ".": "./main.js",
 *   "./foo": {
 *     "import": "./foo.js",
 *     "require": "./foo.cjs"
 *   }
 * }
 */
type NormalizedExports = Record<SubpathMatcher, SubpathTarget | Record<Condition, SubpathTarget>>

// https://github.com/nodejs/node/blob/6fd67ec6e3ccbdfcfa0300b9b742040a0607a4bc/lib/internal/modules/esm/resolve.js#L555
function isConditionalExportsMainSugar(exports: any) {
  if (typeof exports === 'string' || Array.isArray(exports)) {
    return true
  }
  if (typeof exports !== 'object' || exports === null) {
    return false
  }

  // not doing validation at this point, if the package.json was misconfigured
  // we would not get to this point as it would throw when running `next build`
  const keys = Object.keys(exports)
  return keys.length > 0 && (keys[0] === '' || keys[0][0] !== '.')
}

// https://github.com/nodejs/node/blob/6fd67ec6e3ccbdfcfa0300b9b742040a0607a4bc/lib/internal/modules/esm/resolve.js#L671
function patternKeyCompare(a: string, b: string) {
  const aPatternIndex = a.indexOf('*')
  const bPatternIndex = b.indexOf('*')
  const baseLenA = aPatternIndex === -1 ? a.length : aPatternIndex + 1
  const baseLenB = bPatternIndex === -1 ? b.length : bPatternIndex + 1
  if (baseLenA > baseLenB) {
    return -1
  }
  if (baseLenB > baseLenA) {
    return 1
  }
  if (aPatternIndex === -1) {
    return 1
  }
  if (bPatternIndex === -1) {
    return -1
  }
  if (a.length > b.length) {
    return -1
  }
  if (b.length > a.length) {
    return 1
  }
  return 0
}

function applyWildcardMatch(target: string, bestMatchSubpath?: string) {
  return bestMatchSubpath ? target.replace('*', bestMatchSubpath) : target
}

// https://github.com/nodejs/node/blob/323f19c18fea06b9234a0c945394447b077fe565/lib/internal/modules/helpers.js#L76
const conditions = new Set(['require', 'node', 'node-addons', 'default'])

// https://github.com/nodejs/node/blob/6fd67ec6e3ccbdfcfa0300b9b742040a0607a4bc/lib/internal/modules/esm/resolve.js#L480
function matchConditions(target: SubpathTarget, bestMatchSubpath?: string) {
  if (typeof target === 'string') {
    return applyWildcardMatch(target, bestMatchSubpath)
  }

  if (Array.isArray(target) && target.length > 0) {
    for (const targetItem of target) {
      return matchConditions(targetItem, bestMatchSubpath)
    }
  }

  if (typeof target === 'object' && target !== null) {
    for (const [condition, targetValue] of Object.entries(target)) {
      if (conditions.has(condition)) {
        return matchConditions(targetValue, bestMatchSubpath)
      }
    }
  }

  throw new Error('Invalid package target')
}

function getPackageResolver(packageJsonMatchedModule: RegisteredModule) {
  const memoized = memoizedPackageResolvers.get(packageJsonMatchedModule)
  if (memoized) {
    return memoized
  }

  // https://nodejs.org/api/packages.html#package-entry-points

  const pkgJson = parseJson(packageJsonMatchedModule)

  let exports: NormalizedExports | null = null
  if (pkgJson.exports) {
    // https://github.com/nodejs/node/blob/6fd67ec6e3ccbdfcfa0300b9b742040a0607a4bc/lib/internal/modules/esm/resolve.js#L590
    exports = isConditionalExportsMainSugar(pkgJson.exports)
      ? { '.': pkgJson.exports }
      : pkgJson.exports
  }

  const resolveInPackage: ModuleResolutions = (subpath: string) => {
    if (exports) {
      const normalizedSubpath = subpath.length === 0 ? '.' : './' + subpath

      // https://github.com/nodejs/node/blob/6fd67ec6e3ccbdfcfa0300b9b742040a0607a4bc/lib/internal/modules/esm/resolve.js#L594
      // simple case with matching as-is
      if (
        normalizedSubpath in exports &&
        !normalizedSubpath.includes('*') &&
        !normalizedSubpath.endsWith('/')
      ) {
        return matchConditions(exports[normalizedSubpath])
      }

      // https://github.com/nodejs/node/blob/6fd67ec6e3ccbdfcfa0300b9b742040a0607a4bc/lib/internal/modules/esm/resolve.js#L610
      let bestMatchKey = ''
      let bestMatchSubpath
      for (const key of Object.keys(exports)) {
        const patternIndex = key.indexOf('*')
        if (patternIndex !== -1 && normalizedSubpath.startsWith(key.slice(0, patternIndex))) {
          const patternTrailer = key.slice(patternIndex + 1)
          if (
            normalizedSubpath.length > key.length &&
            normalizedSubpath.endsWith(patternTrailer) &&
            patternKeyCompare(bestMatchKey, key) === 1 &&
            key.lastIndexOf('*') === patternIndex
          ) {
            bestMatchKey = key
            bestMatchSubpath = normalizedSubpath.slice(
              patternIndex,
              normalizedSubpath.length - patternTrailer.length,
            )
          }
        }
      }

      if (bestMatchKey && typeof bestMatchSubpath === 'string') {
        const matchedTarget = exports[bestMatchKey]
        return matchConditions(matchedTarget, bestMatchSubpath)
      }

      // if exports are defined, they are source of truth and any imports not allowed by it will fail
      throw new Error(`Cannot find module '${normalizedSubpath}'`)
    }

    if (subpath.length === 0 && pkgJson.main) {
      return pkgJson.main
    }

    return subpath
  }

  memoizedPackageResolvers.set(packageJsonMatchedModule, resolveInPackage)

  return resolveInPackage
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
      const modRequire = createRequire(pathToFileURL(filepath, { windows: false }))
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
  const basePath = dirname(toPosixPath(fileURLToPath(baseUrl, { windows: false })))

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
        const requireFrom = toPosixPath(args?.[1]?.filename)

        target = join(dirname(requireFrom), args[0])
      }

      let matchedModule = tryMatchingWithIndex(target)

      if (!isRelative && !target.startsWith('/')) {
        const packageName = target.startsWith('@')
          ? target.split('/').slice(0, 2).join('/')
          : target.split('/')[0]
        const moduleInPackagePath = target.slice(packageName.length + 1)

        for (const nodeModulePathsRaw of args[1].paths) {
          const nodeModulePaths = toPosixPath(nodeModulePathsRaw)
          const potentialPackageJson = join(nodeModulePaths, packageName, 'package.json')

          const maybePackageJson = registeredModules.get(potentialPackageJson)

          let relativeTarget = moduleInPackagePath

          if (maybePackageJson) {
            const packageResolver = getPackageResolver(maybePackageJson)

            relativeTarget = packageResolver(moduleInPackagePath)
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
