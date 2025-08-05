import { Module, createRequire } from 'node:module'
import vm from 'node:vm'
import { join, dirname } from 'node:path/posix'
import { fileURLToPath, pathToFileURL } from 'node:url'

type RegisteredModule = {
  source: string
  loaded: boolean
  filename: string
}
const registeredModules = new Map<string, RegisteredModule>()

const require = createRequire(import.meta.url)

let hookedIn = false

function seedCJSModuleCacheAndReturnTarget(matchedModule: RegisteredModule, parent: Module) {
  console.error('matched', matchedModule.filename)
  if (matchedModule.loaded) {
    return matchedModule.filename
  }
  const { source, filename } = matchedModule
  console.error('evaluating module', { filename })

  const mod = new Module(filename)
  mod.parent = parent
  mod.filename = filename
  mod.path = dirname(filename)
  // @ts-expect-error - private untyped API
  mod.paths = Module._nodeModulePaths(mod.path)
  require.cache[filename] = mod

  const wrappedSource = `(function (exports, require, module, __filename, __dirname) { ${source}\n});`
  const compiled = vm.runInThisContext(wrappedSource, {
    filename,
    lineOffset: 0,
    displayErrors: true,
  })
  compiled(mod.exports, createRequire(pathToFileURL(filename)), mod, filename, dirname(filename))
  mod.loaded = matchedModule.loaded = true

  console.error('evaluated module', { filename })
  return filename
}

const exts = ['.js', '.cjs', '.json']

function tryWithExtensions(filename: string) {
  // console.error('trying to match', filename)
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
  console.error('trying to match', target)
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

    registeredModules.set(target, { source, loaded: false, filename: target })
  }

  console.error([...registeredModules.values()].map((m) => m.filename))

  if (!hookedIn) {
    // magic
    // @ts-expect-error - private untyped API
    const original_resolveFilename = Module._resolveFilename.bind(Module)
    // @ts-expect-error - private untyped API
    Module._resolveFilename = (...args) => {
      console.error(
        'resolving file name for specifier',
        args[0] ?? '--missing specifier--',
        'from',
        args[1]?.filename ?? 'unknown',
      )
      let target = args[0]
      let isRelative = args?.[0].startsWith('.')

      if (isRelative) {
        // only handle relative require paths
        const requireFrom = args?.[1]?.filename

        target = join(dirname(requireFrom), args[0])
      }

      let matchedModule = tryMatchingWithIndex(target)

      if (!isRelative && !target.startsWith('/')) {
        console.log('not relative, checking node_modules', args[0])
        for (const nodeModulePaths of args[1].paths) {
          const potentialPath = join(nodeModulePaths, target)
          console.log('checking potential path', potentialPath)
          matchedModule = tryMatchingWithIndex(potentialPath)
          if (matchedModule) {
            break
          }
        }
      }

      if (matchedModule) {
        console.log('matched module', matchedModule.filename)
        return seedCJSModuleCacheAndReturnTarget(matchedModule, args[1])
      }

      return original_resolveFilename(...args)
    }

    hookedIn = true
  }
}
