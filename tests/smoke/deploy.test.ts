import { afterEach, describe, expect, test } from 'vitest'
import { Fixture, fixtureFactories } from '../utils/create-e2e-fixture'

const usedFixtures = new Set<Fixture>()
/**
 * When fixture is used, it is automatically cleanup after test finishes
 */
const selfCleaningFixtureFactories = new Proxy(fixtureFactories, {
  get(target, prop) {
    return async () => {
      const val = target[prop]
      if (typeof val === 'function') {
        const fixture = await val()
        usedFixtures.add(fixture)
        return fixture
      }

      return val
    }
  },
})

afterEach(async () => {
  for (const fixture of usedFixtures) {
    await fixture.cleanup()
  }
  usedFixtures.clear()
})

async function smokeTest(createFixture: () => Promise<Fixture>) {
  const fixture = await createFixture()
  const response = await fetch(fixture.url)
  expect(response.status).toBe(200)

  // remove comments that React injects into produced html
  const body = (await response.text()).replace(/<!--.+-->/g, '')
  await expect(body).toContain('SSR: yes')
}

test('yarn@3 monorepo with pnpm linker', async () => {
  await smokeTest(selfCleaningFixtureFactories.yarnMonorepoWithPnpmLinker)
})

test('npm monorepo deploying from site directory without --filter', async () => {
  await smokeTest(selfCleaningFixtureFactories.npmMonorepoEmptyBaseNoPackagePath)
})

test('npm monorepo creating site workspace as part of build step (no packagePath set)', async () => {
  await smokeTest(selfCleaningFixtureFactories.npmMonorepoSiteCreatedAtBuild)
})

describe('version check', () => {
  test(
    'next@12.0.3 (first version building on recent node versions) should not deploy',
    { retry: 0 },
    async () => {
      // we are not able to get far enough to extract concrete next version, so this error message lack used Next.js version
      await expect(selfCleaningFixtureFactories.next12_0_3()).rejects.toThrow(
        /Your publish directory does not contain expected Next.js build output. Please make sure you are using Next.js version \(>=13.5.0\)/,
      )
    },
  )
  test(
    'next@12.1.0 (first version with standalone output supported) should not deploy',
    { retry: 0 },
    async () => {
      await expect(selfCleaningFixtureFactories.next12_1_0()).rejects.toThrow(
        new RegExp(
          `@netlify/plugin-nextjs@5 requires Next.js version >=13.5.0, but found 12.1.0. Please upgrade your project's Next.js version.`,
        ),
      )
    },
  )
  test(
    'yarn monorepo multiple next versions site is compatible',
    { retry: 0, timeout: 1_000 * 60 * 5 },
    async () => {
      await smokeTest(selfCleaningFixtureFactories.yarnMonorepoMultipleNextVersionsSiteCompatible)
    },
  )

  test(
    'yarn monorepo multiple next versions site is incompatible should not deploy',
    { retry: 0 },
    async () => {
      await expect(
        selfCleaningFixtureFactories.yarnMonorepoMultipleNextVersionsSiteIncompatible(),
      ).rejects.toThrow(
        new RegExp(
          `@netlify/plugin-nextjs@5 requires Next.js version >=13.5.0, but found 13.4.1. Please upgrade your project's Next.js version.`,
        ),
      )
    },
  )

  test('npm nested site multiple next versions site is compatible', async () => {
    await smokeTest(fixtureFactories.npmNestedSiteMultipleNextVersionsCompatible)
  })

  test(
    'npm nested site multiple next versions site is incompatible should not deploy',
    { retry: 0 },
    async () => {
      await expect(
        fixtureFactories.npmNestedSiteMultipleNextVersionsIncompatible(),
      ).rejects.toThrow(
        new RegExp(
          `@netlify/plugin-nextjs@5 requires Next.js version >=13.5.0, but found 13.4.1. Please upgrade your project's Next.js version.`,
        ),
      )
    },
  )
})
