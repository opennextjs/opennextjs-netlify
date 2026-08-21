import { cp, lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize, relative } from 'node:path/posix'

import type { Manifest, ManifestFunction } from '@netlify/edge-functions'
import { glob } from 'fast-glob'
import type { FunctionsConfigManifest } from 'next-with-cache-handler-v2/dist/build/index.js'
import type { EdgeFunctionDefinition as EdgeMiddlewareDefinition } from 'next-with-cache-handler-v2/dist/build/webpack/plugins/middleware-plugin.js'

import { EDGE_HANDLER_NAME, PluginContext } from '../plugin-context.js'

type NodeMiddlewareDefinitionWithOptionalMatchers = FunctionsConfigManifest['functions'][0]
type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] }
type NodeMiddlewareDefinition = WithRequired<
  NodeMiddlewareDefinitionWithOptionalMatchers,
  'matchers'
>

function nodeMiddlewareDefinitionHasMatcher(
  definition: NodeMiddlewareDefinitionWithOptionalMatchers,
): definition is NodeMiddlewareDefinition {
  return Array.isArray(definition.matchers)
}

type EdgeOrNodeMiddlewareDefinition = {
  runtime: 'nodejs' | 'edge'
  // hoisting shared properties from underlying definitions for common handling
  name: string
  matchers: EdgeMiddlewareDefinition['matchers']
} & (
  | {
      runtime: 'nodejs'
      functionDefinition: NodeMiddlewareDefinition
    }
  | {
      runtime: 'edge'
      functionDefinition: EdgeMiddlewareDefinition
    }
)

const writeEdgeManifest = async (
  ctx: PluginContext,
  manifest: Manifest & { import_map?: string },
) => {
  await mkdir(ctx.edgeFunctionsDir, { recursive: true })
  await writeFile(join(ctx.edgeFunctionsDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

const copyRuntime = async (ctx: PluginContext, handlerDirectory: string): Promise<void> => {
  const files = await glob('edge-runtime/**/*', {
    cwd: ctx.pluginDir,
    ignore: ['**/*.test.ts'],
    dot: true,
  })
  await Promise.all(
    files.map((path) =>
      cp(join(ctx.pluginDir, path), join(handlerDirectory, path), { recursive: true }),
    ),
  )
}

const fixEdgeRuntimeTurbopackMatcherJsonPart = (matchers: EdgeMiddlewareDefinition['matchers']) => {
  return matchers.map((matcher) => {
    if (matcher.regexp) {
      return {
        ...matcher,
        // Next.js in some versions produces "\\\\.json" for edge runtime middleware when built with turbopack
        // with too many escapes preventing proper matching
        regexp: matcher.regexp.replaceAll('\\\\.json', '\\.json'),
      }
    }
    return matcher
  })
}

/**
 * When i18n is enabled the matchers assume that paths _always_ include the
 * locale. We manually add an extra matcher for the original path without
 * the locale to ensure that the edge function can handle it.
 * We don't need to do this for data routes because they always have the locale.
 */
const augmentMatchers = (
  matchers: EdgeMiddlewareDefinition['matchers'],
  ctx: PluginContext,
): EdgeMiddlewareDefinition['matchers'] => {
  const i18NConfig = ctx.buildConfig.i18n
  if (!i18NConfig) {
    return matchers
  }
  return matchers.flatMap((matcher) => {
    if (matcher.originalSource && matcher.locale !== false) {
      return [
        matcher.regexp
          ? {
              ...matcher,
              // https://github.com/vercel/next.js/blob/5e236c9909a768dc93856fdfad53d4f4adc2db99/packages/next/src/build/analysis/get-page-static-info.ts#L332-L336
              // Next is producing pretty broad matcher for i18n locale. Presumably rest of their infrastructure protects this broad matcher
              // from matching on non-locale paths. For us this becomes request entry point, so we need to narrow it down to just defined locales
              // otherwise users might get unexpected matches on paths like `/api*`
              // additionally we don't have a way to normalize i18n paths for request without locale information, so we need to adjust the regexp to mark locale part as optional
              regexp: matcher.regexp
                // replace i18n part matching:
                //  - target locales only
                //  - make it optional to allow matching both with and without locale
                // (?:\\/((?!_next\\/)[^/.]{1,}))
                .replace(
                  '(?:\\/((?!_next\\/)[^/.]{1,}))',
                  `(?:\\/((?!_next\\/)(${i18NConfig.locales.join('|')}){1,}))?`,
                ),
            }
          : matcher,
      ]
    }
    return matcher
  })
}

const writeHandlerFile = async (
  ctx: PluginContext,
  { matchers, name }: EdgeOrNodeMiddlewareDefinition,
) => {
  const nextConfig = ctx.buildConfig
  const handlerName = getHandlerName({ name })
  const handlerDirectory = join(ctx.edgeFunctionsDir, handlerName)
  const handlerRuntimeDirectory = join(handlerDirectory, 'edge-runtime')

  // Copying the runtime files. These are the compatibility layer between
  // Netlify Edge Functions and the Next.js edge runtime.
  await copyRuntime(ctx, handlerDirectory)

  // Writing a file with the matchers that should trigger this function. We'll
  // read this file from the function at runtime.
  await writeFile(join(handlerRuntimeDirectory, 'matchers.json'), JSON.stringify(matchers))

  // The config is needed by the edge function to match and normalize URLs. To
  // avoid shipping and parsing a large file at runtime, let's strip it down to
  // just the properties that the edge function actually needs.
  const minimalNextConfig = {
    basePath: nextConfig.basePath,
    i18n: nextConfig.i18n,
    trailingSlash: nextConfig.trailingSlash,
    skipMiddlewareUrlNormalize:
      nextConfig.skipProxyUrlNormalize ?? nextConfig.skipMiddlewareUrlNormalize,
  }

  await writeFile(
    join(handlerRuntimeDirectory, 'next.config.json'),
    JSON.stringify(minimalNextConfig),
  )

  // Writing the function entry file. It wraps the middleware code with the
  // compatibility layer mentioned above.
  await writeFile(
    join(handlerDirectory, `${handlerName}.js`),
    `
    import { handleMiddleware } from './edge-runtime/middleware.ts';
    import handler from './server/${name}.js';

    export default (req, context) => handleMiddleware(req, context, handler);
    `,
  )
}

const copyHandlerDependenciesForEdgeMiddleware = async (
  ctx: PluginContext,
  { name, env, files, wasm }: EdgeMiddlewareDefinition,
) => {
  const srcDir = join(ctx.standaloneDir, ctx.nextDistDir)
  const destDir = join(ctx.edgeFunctionsDir, getHandlerName({ name }))

  const edgeRuntimeDir = join(ctx.pluginDir, 'edge-runtime')
  const shimPath = join(edgeRuntimeDir, 'shim/edge.js')
  const shim = await readFile(shimPath, 'utf8')

  const parts = [shim]

  const outputFile = join(destDir, `server/${name}.js`)

  if (env) {
    // Prepare environment variables for draft-mode (i.e. __NEXT_PREVIEW_MODE_ID, __NEXT_PREVIEW_MODE_SIGNING_KEY, __NEXT_PREVIEW_MODE_ENCRYPTION_KEY)
    for (const [key, value] of Object.entries(env)) {
      parts.push(`process.env.${key} = '${value}';`)
    }
  }

  if (wasm?.length) {
    for (const wasmChunk of wasm ?? []) {
      const data = await readFile(join(srcDir, wasmChunk.filePath))
      parts.push(`const ${wasmChunk.name} = Uint8Array.from(${JSON.stringify([...data])})`)
    }
  }

  for (const file of files) {
    const entrypoint = await readFile(join(srcDir, file), 'utf8')
    parts.push(`;// Concatenated file: ${file} \n`, entrypoint)
  }
  parts.push(
    `const middlewareEntryKey = Object.keys(_ENTRIES).find(entryKey => entryKey.startsWith("middleware_${name}"));`,
    // turbopack entries are promises so we await here to get actual entry
    // non-turbopack entries are already resolved, so await does not change anything
    `export default await _ENTRIES[middlewareEntryKey].default;`,
  )
  await mkdir(dirname(outputFile), { recursive: true })

  await writeFile(outputFile, parts.join('\n'))
}

const NODE_MIDDLEWARE_NAME = 'node-middleware'

type NodeMiddlewareImportMap = { imports: Record<string, string> }

const packageNameFromNodeModulesPath = (posixPath: string): string | null => {
  const marker = 'node_modules/'
  const idx = posixPath.lastIndexOf(marker)
  if (idx === -1) {
    return null
  }
  const rest = posixPath.slice(idx + marker.length)
  if (!rest) {
    return null
  }
  if (rest.startsWith('@')) {
    const [scope, name] = rest.split('/')
    if (!scope || !name) {
      return null
    }
    return `${scope}/${name}`
  }
  return rest.split('/')[0] ?? null
}

const packageDirFromNodeModulesPath = (posixPath: string): string | null => {
  const name = packageNameFromNodeModulesPath(posixPath)
  if (!name) {
    return null
  }
  const marker = 'node_modules/'
  const idx = posixPath.lastIndexOf(marker)
  return posixPath.slice(0, idx + marker.length) + name
}

const matchEsmExportTarget = (target: unknown): string | null => {
  if (typeof target === 'string') {
    return target
  }
  if (Array.isArray(target)) {
    for (const item of target) {
      const matched = matchEsmExportTarget(item)
      if (matched) {
        return matched
      }
    }
    return null
  }
  if (target && typeof target === 'object') {
    const record = target as Record<string, unknown>
    for (const condition of ['import', 'default', 'module', 'node']) {
      if (condition in record) {
        const matched = matchEsmExportTarget(record[condition])
        if (matched) {
          return matched
        }
      }
    }
  }
  return null
}

const getEsmEntryRelPath = (pkgJson: Record<string, unknown>): string | null => {
  if (pkgJson.exports) {
    const exportsField = pkgJson.exports
    const main =
      typeof exportsField === 'object' &&
      exportsField !== null &&
      !Array.isArray(exportsField) &&
      '.' in (exportsField as Record<string, unknown>)
        ? (exportsField as Record<string, unknown>)['.']
        : exportsField
    const matched = matchEsmExportTarget(main)
    if (matched) {
      return matched.replace(/^\.\//, '')
    }
  }
  if (typeof pkgJson.module === 'string') {
    return pkgJson.module.replace(/^\.\//, '')
  }
  if (pkgJson.type === 'module' && typeof pkgJson.main === 'string') {
    return pkgJson.main.replace(/^\.\//, '')
  }
  return null
}

const isEsmOnlyPackage = (pkgJson: Record<string, unknown>): boolean => {
  if (pkgJson.type === 'module') {
    const exportsField = pkgJson.exports
    if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
      const main =
        '.' in (exportsField as Record<string, unknown>)
          ? (exportsField as Record<string, unknown>)['.']
          : exportsField
      if (main && typeof main === 'object' && !Array.isArray(main) && 'require' in main) {
        return false
      }
    }
    return true
  }
  return typeof pkgJson.main === 'string' && pkgJson.main.endsWith('.mjs')
}

const isHashedTurbopackSpecifier = (name: string): boolean => /-[a-f0-9]{8,}$/i.test(name)

const isNextAliasTreePath = (posixPath: string): boolean =>
  posixPath === '.next/node_modules' ||
  posixPath.startsWith('.next/node_modules/') ||
  posixPath.includes('/.next/node_modules/')

const copyHandlerDependenciesForNodeMiddleware = async (
  ctx: PluginContext,
): Promise<NodeMiddlewareImportMap | undefined> => {
  const name = NODE_MIDDLEWARE_NAME

  const srcDir = join(ctx.standaloneDir, ctx.nextDistDir)
  const destDir = join(ctx.edgeFunctionsDir, getHandlerName({ name }))

  const edgeRuntimeDir = join(ctx.pluginDir, 'edge-runtime')
  const shimPath = join(edgeRuntimeDir, 'shim/node.js')
  const shim = await readFile(shimPath, 'utf8')

  const parts = [shim]

  const entry = 'server/middleware.js'
  const nft = `${entry}.nft.json`
  const nftFilesPath = join(ctx.publishDir, nft)
  const nftManifest = JSON.parse(await readFile(nftFilesPath, 'utf8'))

  const files: string[] = nftManifest.files.map((file: string) => join('server', file))
  files.push(entry)

  // files are relative to location of middleware entrypoint
  // we need to capture all of them
  // they might be going to parent directories, so first we check how many directories we need to go up
  const { maxParentDirectoriesPath, unsupportedDotNodeModules } = files.reduce(
    (acc, file) => {
      let dirsUp = 0
      let parentDirectoriesPath = ''
      for (const part of file.split('/')) {
        if (part === '..') {
          dirsUp += 1
          parentDirectoriesPath += '../'
        } else {
          break
        }
      }

      if (file.endsWith('.node')) {
        // C++ addons are not supported
        acc.unsupportedDotNodeModules.push(join(srcDir, file))
      }

      if (dirsUp > acc.maxDirsUp) {
        return {
          ...acc,
          maxDirsUp: dirsUp,
          maxParentDirectoriesPath: parentDirectoriesPath,
        }
      }

      return acc
    },
    { maxDirsUp: 0, maxParentDirectoriesPath: '', unsupportedDotNodeModules: [] as string[] },
  )

  if (unsupportedDotNodeModules.length !== 0) {
    throw new Error(
      `Usage of unsupported C++ Addon(s) found in Node.js Middleware:\n${unsupportedDotNodeModules.map((file) => `- ${file}`).join('\n')}\n\nCheck https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/#limitations for more information.`,
    )
  }

  const commonPrefix = relative(join(srcDir, maxParentDirectoriesPath), srcDir)

  parts.push(`const virtualModules = new Map();`, `const virtualSymlinks = new Map();`)

  const writtenSources = new Map<string, string>()
  const hashedSpecifiers = new Map<string, string>()

  const handleFileOrDirectory = async (fileOrDir: string) => {
    const srcPath = join(srcDir, fileOrDir)

    const stats = await lstat(srcPath)
    if (stats.isDirectory()) {
      const filesInDir = await readdir(srcPath)
      for (const fileInDir of filesInDir) {
        await handleFileOrDirectory(join(fileOrDir, fileInDir))
      }
    } else if (stats.isSymbolicLink()) {
      const symlinkTarget = await readlink(srcPath)
      const registeredPath = join(commonPrefix, fileOrDir)
      parts.push(
        `virtualSymlinks.set(${JSON.stringify(registeredPath)}, ${JSON.stringify(symlinkTarget)});`,
      )
      // Turbopack emits hashed bare specifiers as `.next/node_modules/<name>-<hash>`
      // symlinks. Those names are what `import()` looks up at runtime.
      if (basename(dirname(registeredPath)) === 'node_modules') {
        hashedSpecifiers.set(
          basename(registeredPath),
          normalize(join(dirname(registeredPath), symlinkTarget)),
        )
      }
    } else {
      const content = await readFile(srcPath, 'utf8')
      const registeredPath = join(commonPrefix, fileOrDir)
      writtenSources.set(registeredPath, content)
    }
  }

  for (const file of files) {
    await handleFileOrDirectory(file)
  }

  // ESM externals are loaded with Deno `import()`, which never hits the virtual
  // CJS registry. Materialize those packages as real files and map both the
  // package name (webpack) and the hashed turbopack specifier onto the ESM entry.
  // The internal edge-functions manifest `import_map` field is how Netlify's
  // edge bundler picks this up:
  // https://github.com/netlify/edge-bundler/blob/main/node/deploy_config.ts
  const esmEntries = new Map<string, string>()
  const configuredExternals = new Set(
    (ctx.buildConfig as { serverExternalPackages?: string[] }).serverExternalPackages ?? [],
  )

  const tryAddEsmEntry = (specifier: string, pkgDir: string) => {
    const pkgJsonRaw =
      writtenSources.get(join(pkgDir, 'package.json')) ??
      writtenSources.get(join('.next/node_modules', specifier, 'package.json'))
    if (!pkgJsonRaw) {
      return
    }
    let pkgJson: Record<string, unknown>
    try {
      pkgJson = JSON.parse(pkgJsonRaw) as Record<string, unknown>
    } catch {
      return
    }
    if (!isEsmOnlyPackage(pkgJson)) {
      return
    }
    const entryRel = getEsmEntryRelPath(pkgJson)
    if (!entryRel) {
      return
    }
    esmEntries.set(specifier, join(pkgDir, entryRel))
  }

  for (const [path] of writtenSources) {
    if (!path.endsWith('package.json') || !path.includes('node_modules/')) {
      continue
    }
    if (isNextAliasTreePath(path)) {
      continue
    }
    const pkgDir = packageDirFromNodeModulesPath(path)
    const pkgName = packageNameFromNodeModulesPath(path)
    if (!pkgDir || !pkgName || isHashedTurbopackSpecifier(pkgName)) {
      continue
    }
    if (!configuredExternals.has(pkgName)) {
      continue
    }
    tryAddEsmEntry(pkgName, pkgDir)
  }

  // Test copies and some filesystems dereference the Turbopack alias symlink,
  // so the hashed name shows up as a real directory of files instead of a link.
  for (const [path, content] of writtenSources) {
    const match = path.match(/(?:^|\/)\.next\/node_modules\/([^/]+)\/package\.json$/)
    if (!match || !isHashedTurbopackSpecifier(match[1])) {
      continue
    }
    let pkgJson: Record<string, unknown>
    try {
      pkgJson = JSON.parse(content) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof pkgJson.name === 'string') {
      hashedSpecifiers.set(match[1], `node_modules/${pkgJson.name}`)
    }
  }

  for (const [specifier, pkgDir] of hashedSpecifiers) {
    tryAddEsmEntry(specifier, pkgDir)
    const pkgName = packageNameFromNodeModulesPath(join(pkgDir, 'package.json'))
    if (pkgName) {
      tryAddEsmEntry(pkgName, pkgDir)
    }
  }

  const packagesToMaterialize = new Set<string>()
  for (const entryPath of esmEntries.values()) {
    const pkgDir = packageDirFromNodeModulesPath(entryPath)
    if (pkgDir) {
      packagesToMaterialize.add(pkgDir)
    }
  }

  const canonicalPathFor = (path: string): string => {
    for (const [specifier, pkgDir] of hashedSpecifiers) {
      const nextAliasRoot = `.next/node_modules/${specifier}`
      if (path === nextAliasRoot || path.startsWith(`${nextAliasRoot}/`)) {
        return pkgDir + path.slice(nextAliasRoot.length)
      }
    }
    return path
  }

  for (const [path, content] of writtenSources) {
    const canonical = canonicalPathFor(path)
    const pkgDir = packageDirFromNodeModulesPath(canonical)
    if (!pkgDir || !packagesToMaterialize.has(pkgDir)) {
      continue
    }
    const outPath = join(destDir, 'server', canonical)
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, content)
  }

  const entryPathToNs = new Map<string, string>()
  const staticImportLines: string[] = []
  let esmImportIndex = 0
  for (const entryPath of new Set(esmEntries.values())) {
    const ns = `__netlifyEsm${esmImportIndex++}`
    entryPathToNs.set(entryPath, ns)
    staticImportLines.push(`import * as ${ns} from ${JSON.stringify(`./${entryPath}`)};`)
  }

  // Deno's eszip build cannot evaluate `import(id)` when `id` is a runtime value
  // ("A dynamic import callback was not specified"). Point Turbopack's
  // externalImport at the statically imported namespace instead.
  const patchExternalImport = (source: string) =>
    source.replaceAll(
      'await import(id)',
      '(globalThis.__netlifyEsmExternals?.[id] ?? await import(id))',
    )

  for (const [path, content] of writtenSources) {
    parts.push(
      `virtualModules.set(${JSON.stringify(path)}, ${JSON.stringify(patchExternalImport(content))});`,
    )
  }

  parts.push(`${staticImportLines.join('\n')}
globalThis.__netlifyEsmExternals = {
${[...esmEntries]
  .map(
    ([specifier, entryPath]) => `  ${JSON.stringify(specifier)}: ${entryPathToNs.get(entryPath)},`,
  )
  .join('\n')}
};
registerCJSModules(import.meta.url, virtualModules, virtualSymlinks);

    const require = createRequire(import.meta.url);
    const middlewareEntrypoint = "${join(commonPrefix, entry)}"
    const handlerMod = await require("./" + middlewareEntrypoint);
    const handler = handlerMod.default || handlerMod;

    export default handler
    `)

  const outputFile = join(destDir, `server/${name}.js`)

  await mkdir(dirname(outputFile), { recursive: true })

  await writeFile(outputFile, parts.join('\n'))

  if (esmEntries.size === 0) {
    return undefined
  }

  const handlerDirName = getHandlerName({ name })
  const imports: Record<string, string> = {}
  for (const [specifier, entryPath] of esmEntries) {
    imports[specifier] = `./${handlerDirName}/server/${entryPath}`
  }

  return { imports }
}

const createEdgeHandler = async (
  ctx: PluginContext,
  definition: EdgeOrNodeMiddlewareDefinition,
): Promise<NodeMiddlewareImportMap | undefined> => {
  let importMap: NodeMiddlewareImportMap | undefined
  if (definition.runtime === 'edge') {
    await copyHandlerDependenciesForEdgeMiddleware(ctx, definition.functionDefinition)
  } else {
    importMap = await copyHandlerDependenciesForNodeMiddleware(ctx)
  }
  await writeHandlerFile(ctx, definition)
  return importMap
}

const getHandlerName = ({ name }: Pick<EdgeMiddlewareDefinition, 'name'>): string =>
  `${EDGE_HANDLER_NAME}-${name.replace(/\W/g, '-')}`

const buildHandlerDefinition = (
  ctx: PluginContext,
  def: EdgeOrNodeMiddlewareDefinition,
): Array<ManifestFunction> => {
  return augmentMatchers(def.matchers, ctx).map((matcher) => ({
    function: getHandlerName({ name: def.name }),
    name: 'Next.js Middleware Handler',
    pattern: matcher.regexp,
    generator: `${ctx.pluginName}@${ctx.pluginVersion}`,
  }))
}

export const clearStaleEdgeHandlers = async (ctx: PluginContext) => {
  await rm(ctx.edgeFunctionsDir, { recursive: true, force: true })
}

export const createEdgeHandlers = async (ctx: PluginContext) => {
  // Edge middleware
  const nextManifest = await ctx.getMiddlewareManifest()
  const middlewareDefinitions: EdgeOrNodeMiddlewareDefinition[] = [
    ...Object.values(nextManifest.middleware),
  ].map((edgeDefinition) => {
    return {
      runtime: 'edge',
      functionDefinition: edgeDefinition,
      name: edgeDefinition.name,
      matchers: fixEdgeRuntimeTurbopackMatcherJsonPart(edgeDefinition.matchers),
    }
  })

  // Node middleware
  const functionsConfigManifest = await ctx.getFunctionsConfigManifest()
  if (
    functionsConfigManifest?.functions?.['/_middleware'] &&
    nodeMiddlewareDefinitionHasMatcher(functionsConfigManifest?.functions?.['/_middleware'])
  ) {
    middlewareDefinitions.push({
      runtime: 'nodejs',
      functionDefinition: functionsConfigManifest?.functions?.['/_middleware'],
      name: NODE_MIDDLEWARE_NAME,
      matchers: functionsConfigManifest?.functions?.['/_middleware']?.matchers,
    })
  }

  const importMaps = await Promise.all(
    middlewareDefinitions.map((def) => createEdgeHandler(ctx, def)),
  )

  const netlifyDefinitions = middlewareDefinitions.flatMap((def) =>
    buildHandlerDefinition(ctx, def),
  )

  const imports = Object.assign({}, ...importMaps.map((map) => map?.imports ?? {})) as Record<
    string,
    string
  >
  const netlifyManifest: Manifest & { import_map?: string } = {
    version: 1,
    functions: netlifyDefinitions,
  }
  if (Object.keys(imports).length > 0) {
    await writeFile(
      join(ctx.edgeFunctionsDir, 'import_map.json'),
      JSON.stringify({ imports }, null, 2),
    )
    netlifyManifest.import_map = './import_map.json'
  }
  await writeEdgeManifest(ctx, netlifyManifest)
}
