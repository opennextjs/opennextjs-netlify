const { readdirSync, existsSync } = require('fs')
const path = require('path')

const makeDir = require('make-dir')

const { restoreCache, saveCache } = require('./helpers/cacheBuild')
const checkNxConfig = require('./helpers/checkNxConfig')
const copyUnstableIncludedDirs = require('./helpers/copyUnstableIncludedDirs')
const doesNotNeedPlugin = require('./helpers/doesNotNeedPlugin')
const getNextConfig = require('./helpers/getNextConfig')
const getNextRoot = require('./helpers/getNextRoot')
const validateNextUsage = require('./helpers/validateNextUsage')
const verifyBuildTarget = require('./helpers/verifyBuildTarget')
const nextOnNetlify = require('./src')
// * Helpful Plugin Context *
// - Between the prebuild and build steps, the project's build command is run
// - Between the build and postbuild steps, any functions are bundled

module.exports = {
  async onPreBuild({ netlifyConfig, packageJson, utils, constants }) {
    const { failBuild } = utils.build

    validateNextUsage({ failBuild, netlifyConfig })

    const hasNoPackageJson = Object.keys(packageJson).length === 0
    if (hasNoPackageJson) {
      return failBuild('Could not find a package.json for this project')
    }

    if (doesNotNeedPlugin({ netlifyConfig, packageJson, failBuild })) {
      return
    }

    // This doesn't seem to work yet, but should once support is in the CLI
    // eslint-disable-next-line no-param-reassign
    netlifyConfig.functions['*'].external_node_modules = [
      ...(netlifyConfig.functions['*'].external_node_modules || []),
      '@ampproject/toolbox-optimizer',
    ]

    // Populates the correct config if needed
    await verifyBuildTarget({ netlifyConfig, packageJson, failBuild })
    const nextRoot = getNextRoot({ netlifyConfig })

    // Because we memoize nextConfig, we need to do this after the write file
    const nextConfig = await getNextConfig(utils.failBuild, nextRoot)

    // Nx needs special config handling, so check for it specifically
    const isNx = Boolean(
      (packageJson.devDependencies && packageJson.devDependencies['@nrwl/next']) ||
        (packageJson.dependencies && packageJson.dependencies['@nrwl/next']),
    )

    if (isNx) {
      console.log('Detected Nx site. Checking configuration...')
      checkNxConfig({ netlifyConfig, packageJson, nextConfig, failBuild, constants })
    }

    if (process.env.NEXT_IMAGE_ALLOWED_DOMAINS) {
      console.log(
        `The Essential Next.js plugin now supports reading image domains from your Next config, so using NEXT_IMAGE_ALLOWED_DOMAINS is now deprecated. Please set images.domains in next.config.js instead, and remove the NEXT_IMAGE_ALLOWED_DOMAINS variable.`,
      )
    }
    await restoreCache({ cache: utils.cache, distDir: nextConfig.distDir })
  },
  async onBuild({
    netlifyConfig,
    packageJson,
    constants: { PUBLISH_DIR = DEFAULT_PUBLISH_DIR, FUNCTIONS_SRC = DEFAULT_FUNCTIONS_SRC },
    utils,
  }) {
    const { failBuild } = utils.build

    const nextRoot = getNextRoot({ netlifyConfig })

    if (doesNotNeedPlugin({ netlifyConfig, packageJson, failBuild })) {
      return
    }
    console.log('Detected Next.js site. Copying files...')

    const { distDir } = await getNextConfig(failBuild, nextRoot)

    const dist = path.resolve(nextRoot, distDir)
    if (!existsSync(dist)) {
      failBuild(`
Could not find "${distDir}" after building the site, which indicates that "next build" was not run. 
Check that your build command includes "next build". If the site is a monorepo, see https://ntl.fyi/next-monorepo 
for information on configuring the site. If this is not a Next.js site you should remove the Essential Next.js plugin. 
See https://ntl.fyi/remove-plugin for instructions.
      `)
    }

    console.log(`** Running Next on Netlify package **`)

    await makeDir(PUBLISH_DIR)
    await nextOnNetlify({
      functionsDir: path.resolve(FUNCTIONS_SRC),
      publishDir: netlifyConfig.build.publish || PUBLISH_DIR,
      nextRoot,
    })
  },

  async onPostBuild({ netlifyConfig, packageJson, constants: { FUNCTIONS_DIST = DEFAULT_FUNCTIONS_DIST }, utils }) {
    if (doesNotNeedPlugin({ netlifyConfig, packageJson, utils })) {
      utils.status.show({
        title: 'Essential Next.js Build Plugin did not run',
        summary: netlifyConfig.build.command
          ? 'The site either uses static export, manually runs next-on-netlify, or is not a Next.js site'
          : 'The site config does not specify a build command',
      })
      return
    }
    const nextRoot = getNextRoot({ netlifyConfig })

    const nextConfig = await getNextConfig(utils.failBuild, nextRoot)
    await saveCache({ cache: utils.cache, distDir: nextConfig.distDir })
    copyUnstableIncludedDirs({ nextConfig, functionsDist: path.resolve(FUNCTIONS_DIST) })
    utils.status.show({
      title: 'Essential Next.js Build Plugin ran successfully',
      summary: 'Generated serverless functions and stored the Next.js cache',
    })
  },
}

const DEFAULT_FUNCTIONS_SRC = 'netlify/functions'
const DEFAULT_FUNCTIONS_DIST = '.netlify/functions/'
const DEFAULT_PUBLISH_DIR = 'out'
