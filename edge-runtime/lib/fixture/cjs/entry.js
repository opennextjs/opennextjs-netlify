function safeRequire(target) {
  try {
    return require(target)
  } catch (error) {
    return 'ERROR'
  }
}

module.exports = {
  // myself
  entry: __filename,

  // package with no `main` or `exports`
  packageRoot: safeRequire('package'),
  packageInternalModule: safeRequire('package/internal-module'),

  // package with `main`, but no `exports`
  packageMainRoot: safeRequire('package-main'),
  packageMainInternalModule: safeRequire('package-main/internal-module'),

  // package with `exports` (no conditions), but no `main`
  packageExportsRoot: safeRequire('package-exports'),
  packageExportsExportedModule: safeRequire('package-exports/exported-module.js'),
  packageExportsWildcardModuleNoExt: safeRequire('package-exports/wildcard/module'),
  packageExportsWildcardModuleWithExt: safeRequire('package-exports/wildcard/module.js'),
  packageExportsNotAllowedBecauseNotInExportMap: safeRequire('package-exports/not-allowed.js'),

  // symlinked package with exports map (using pnpm style node_modules layout)
  pnpmPackageExportsRoot: safeRequire('pnpm-package-exports'),
  pnpmPackageExportsExportedModule: safeRequire('pnpm-package-exports/exported-module.js'),
  pnpmPackageExportsWildcardModuleNoExt: safeRequire('pnpm-package-exports/wildcard/module'),
  pnpmPackageExportsWildcardModuleWithExt: safeRequire('pnpm-package-exports/wildcard/module.js'),
  pnpmPackageExportsNotAllowedBecauseNotInExportMap: safeRequire(
    'pnpm-package-exports/not-allowed.js',
  ),

  // package with `exports` (with conditions, including nested ones), but no `main`
  packageExportsConditionsRoot: safeRequire('package-exports-conditions'),
  packageExportsConditionsExportedModule: safeRequire(
    'package-exports-conditions/exported-module.js',
  ),
  packageExportsConditionsWildcardModuleNoExt: safeRequire(
    'package-exports-conditions/wildcard/module',
  ),
  packageExportsConditionsWildcardModuleWithExt: safeRequire(
    'package-exports-conditions/wildcard/module.js',
  ),

  // package with `exports` and `main` (exports should win)
  packageExportsMainRoot: safeRequire('package-exports-main'),

  // package with `exports` using shorthand / sugar syntax with single export
  packageExportsSugarRoot: safeRequire('package-exports-sugar'),

  // package containing nested package.json that have `main` field
  packageWithNestedPackageJsons: safeRequire('package-with-nested-package-jsons'),
}
