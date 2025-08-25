// package with no `main` or `exports`
const packageRoot = require('package') // should resolve to `index.js`
const packageInternalModule = require('package/internal-module') // should resolve to `internal-module.js`

// package with `main`, but no `exports`
const packageMainRoot = require('package-main') // should resolve to `not-index.js`
const packageMainInternalModule = require('package-main/internal-module') // should resolve to `internal-module.js`

module.exports = {
  packageRoot,
  packageInternalModule,
  packageMainRoot,
  packageMainInternalModule,
  entry: __filename,
}
