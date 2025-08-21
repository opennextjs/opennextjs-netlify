// @ts-check

import { cwd, argv } from 'node:process'
import { join } from 'node:path/posix'
import { readFile, cp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { execaCommand } from 'execa'
import { satisfies } from 'semver'

/**
 * @typedef VariantExpandedCondition
 * @type {object}
 * @property {string} versionConstraint
 * @property {boolean} [canaryOnly]
 */

/**
 * @typedef VariantTest
 * @type {object}
 * @property {Record<string,string | VariantExpandedCondition[]>} dependencies
 */

/**
 * @typedef VariantDescription
 * @type {object}
 * @property {Record<string,string>} [files] file overwrites
 * @property {Record<string,string>} [env] environment variables to set
 * @property {VariantTest} [test] check if version constraints for variant are met
 * @property {string} [buildCommand] command to run
 * @property {string} [distDir] directory to output build artifacts (will be set as )
 */

/** @type {Record<string, VariantDescription>} */
const variantsInput = JSON.parse(await readFile(join(cwd(), 'test-variants.json'), 'utf-8'))

let packageJson = {}
try {
  packageJson = JSON.parse(await readFile(join(cwd(), 'package.json'), 'utf-8'))
} catch {}

/** @type {Record<string, VariantDescription>} */
const variants = {
  ...variantsInput,
  // create default even if not in input, we will need empty object to make sure there is default variant and we can use defaults for everything
  default: {
    // if package.json#test exists, use it
    test: packageJson?.test,
    // use any overwrites from variants file
    ...variantsInput.default,
  },
}

// build variants declared by args or build everything if not args provided
const variantsToBuild = argv.length > 2 ? argv.slice(2) : Object.keys(variants)

/** @type {string[]} */
const notExistingVariants = []
for (const variantToBuild of variantsToBuild) {
  if (!variants[variantToBuild]) {
    notExistingVariants.push(variantToBuild)
  }
}

if (notExistingVariants.length > 0) {
  throw new Error(
    `[build-variants] Variants do not exist: ${notExistingVariants.join(', ')}. Existing variants: ${Object.keys(variants).join(', ')}`,
  )
}

/**
 * Checks if a given version satisfies a constraint and, if `canaryOnly` is true, if it is a canary version.
 * @param {string} version The version to check.
 * @param {string} constraint The constraint to check against.
 * @param {boolean} canaryOnly If true, only canary versions are allowed.
 * @return {boolean} True if the version satisfies the constraint and the canary requirement.
 */
function satisfiesConstraint(version, constraint, canaryOnly) {
  if (!satisfies(version, constraint, { includePrerelease: true })) {
    return false
  }
  if (canaryOnly && !version.includes('-canary')) {
    // If canaryOnly is true, we only allow canary versions
    return false
  }
  return true
}

/** @type {(() => Promise<void>)[]} */
let cleanupTasks = []

async function runCleanup() {
  await Promise.all(cleanupTasks.map((task) => task()))
  cleanupTasks = []
}

for (const variantToBuild of variantsToBuild) {
  const variant = variants[variantToBuild]

  if (variant.test?.dependencies?.next) {
    const nextCondition = variant.test.dependencies.next

    // get next.js version
    const { version } = createRequire(join(cwd(), 'package.json'))('next/package.json')

    const constraintsSatisfied =
      typeof nextCondition === 'string'
        ? satisfiesConstraint(version, nextCondition, false)
        : nextCondition.some(({ versionConstraint, canaryOnly }) =>
            satisfiesConstraint(version, versionConstraint, canaryOnly ?? false),
          )

    if (!constraintsSatisfied) {
      console.warn(
        `[build-variants] Skipping ${variantToBuild} variant because next version (${version}) or canary status (${version.includes('-canary') ? 'is canary' : 'not canary'}) does not satisfy version constraint:\n${JSON.stringify(nextCondition, null, 2)}`,
      )
      continue
    }
  }

  const buildCommand = variant.buildCommand ?? 'next build'
  const distDir = variant.distDir ?? '.next'
  console.warn(
    `[build-variants] Building ${variantToBuild} variant with \`${buildCommand}\` to \`${distDir}\``,
  )

  for (const [target, source] of Object.entries(variant.files ?? {})) {
    const targetBackup = `${target}.bak`
    // create backup
    await cp(target, targetBackup, { force: true })
    // overwrite with new file
    await cp(source, target, { force: true })

    cleanupTasks.push(async () => {
      // restore original
      await cp(targetBackup, target, { force: true })
      // remove backup
      await rm(targetBackup, { force: true })
    })
  }

  const result = await execaCommand(buildCommand, {
    env: {
      ...process.env,
      ...variant.env,
      NEXT_DIST_DIR: distDir,
    },
    stdio: 'inherit',
    reject: false,
  })

  await runCleanup()

  if (result.exitCode !== 0) {
    throw new Error(`[build-variants] Failed to build ${variantToBuild} variant`)
  }
}
