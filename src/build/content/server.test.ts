import { cp, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { NetlifyPluginOptions } from '@netlify/build'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { mockFileSystem } from '../../../tests/index.js'
import { PluginContext, RequiredServerFilesManifest } from '../plugin-context.js'

import {
  copyNextServerCode,
  getPatchesToApply,
  NextInternalModuleReplacement,
  verifyHandlerDirStructure,
} from './server.js'

vi.mock('node:fs', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, unicorn/no-await-expression-member
  const unionFs: any = (await import('unionfs')).default
  const fs = await vi.importActual('node:fs')
  unionFs.reset = () => {
    unionFs.fss = [fs]
  }

  const united = unionFs.use(fs)
  return { default: united, ...united }
})

vi.mock('node:fs/promises', async () => {
  const fs = await import('node:fs')
  return {
    ...fs.promises,
    // seems like this is not exposed with unionFS (?) as we are not asserting on it,
    // this is just a no-op stub for now
    cp: vi.fn(),
  }
})

let mockFS: ReturnType<typeof mockFileSystem> | undefined

vi.mock('fast-glob', async () => {
  const { default: fastGlob } = (await vi.importActual('fast-glob')) as {
    default: typeof import('fast-glob')
  }

  const patchedGlob = async (...args: Parameters<(typeof fastGlob)['glob']>) => {
    if (mockFS) {
      const fs = mockFS.vol
      // https://github.com/mrmlnc/fast-glob/issues/421
      args[1] = {
        ...args[1],
        fs: {
          lstat: fs.lstat.bind(fs),
          // eslint-disable-next-line n/no-sync
          lstatSync: fs.lstatSync.bind(fs),
          stat: fs.stat.bind(fs),
          // eslint-disable-next-line n/no-sync
          statSync: fs.statSync.bind(fs),
          readdir: fs.readdir.bind(fs),
          // eslint-disable-next-line n/no-sync
          readdirSync: fs.readdirSync.bind(fs),
        },
      }
    }

    return fastGlob.glob(...args)
  }

  patchedGlob.glob = patchedGlob

  return {
    default: patchedGlob,
  }
})

const mockFailBuild = vi.fn()
const mockPluginOptions = {
  utils: {
    build: {
      failBuild: mockFailBuild,
    },
  },
} as unknown as NetlifyPluginOptions

const fixtures = {
  get simple() {
    const reqServerFiles = JSON.stringify({
      config: { distDir: '.next' },
      relativeAppDir: '',
    } as RequiredServerFilesManifest)
    const reqServerPath = '.next/required-server-files.json'
    const reqServerPathStandalone = join('.next/standalone', reqServerPath)
    const buildIDPath = join('.netlify/functions-internal/___netlify-server-handler/.next/BUILD_ID')
    mockFS = mockFileSystem({
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [reqServerPath.replace('required-server-files.json', 'prerender-manifest.json')]:
        '{"routes":{}}',
      [buildIDPath]: 'build-id',
    })
    const ctx = new PluginContext({ ...mockPluginOptions, constants: {} } as NetlifyPluginOptions)
    return { ...mockFS, reqServerFiles, reqServerPathStandalone, ctx }
  },
  get monorepo() {
    const reqServerFiles = JSON.stringify({
      config: { distDir: '.next' },
      relativeAppDir: 'apps/my-app',
    } as RequiredServerFilesManifest)
    const reqServerPath = 'apps/my-app/.next/required-server-files.json'
    const reqServerPathStandalone = join('apps/my-app/.next/standalone', reqServerPath)
    const buildIDPath = join(
      'apps/my-app/.netlify/functions-internal/___netlify-server-handler/apps/my-app/.next/BUILD_ID',
    )
    mockFS = mockFileSystem({
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [reqServerPath.replace('required-server-files.json', 'prerender-manifest.json')]:
        '{"routes":{}}',
      [buildIDPath]: 'build-id',
    })
    const ctx = new PluginContext({
      ...mockPluginOptions,
      constants: {
        PACKAGE_PATH: 'apps/my-app',
      },
    } as NetlifyPluginOptions)
    return { ...mockFS, reqServerFiles, reqServerPathStandalone, ctx }
  },
  get nxIntegrated() {
    const reqServerFiles = JSON.stringify({
      config: { distDir: '../../dist/apps/my-app/.next' },
      relativeAppDir: 'apps/my-app',
    } as RequiredServerFilesManifest)
    const reqServerPath = 'dist/apps/my-app/.next/required-server-files.json'
    const reqServerPathStandalone = join('dist/apps/my-app/.next/standalone', reqServerPath)
    const buildIDPath = join(
      'apps/my-app/.netlify/functions-internal/___netlify-server-handler/dist/apps/my-app/.next/BUILD_ID',
    )
    mockFS = mockFileSystem({
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [reqServerPath.replace('required-server-files.json', 'prerender-manifest.json')]:
        '{"routes":{}}',
      [buildIDPath]: 'build-id',
    })
    const ctx = new PluginContext({
      ...mockPluginOptions,
      constants: {
        PACKAGE_PATH: 'apps/my-app',
        PUBLISH_DIR: 'dist/apps/my-app/.next',
      },
    } as NetlifyPluginOptions)
    return { ...mockFS, reqServerFiles, reqServerPathStandalone, ctx }
  },
  get monorepoMissingPackagePath() {
    const reqServerFiles = JSON.stringify({
      config: { distDir: '.next' },
      relativeAppDir: 'apps/my-app',
    } as RequiredServerFilesManifest)
    const reqServerPath = 'apps/my-app/.next/required-server-files.json'
    const reqServerPathStandalone = join('apps/my-app/.next/standalone', reqServerPath)
    const buildIDPath = join(
      '.netlify/functions-internal/___netlify-server-handler/apps/my-app/.next/BUILD_ID',
    )
    mockFS = mockFileSystem({
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [reqServerPath.replace('required-server-files.json', 'prerender-manifest.json')]:
        '{"routes":{}}',
      [buildIDPath]: 'build-id',
    })
    const ctx = new PluginContext({
      ...mockPluginOptions,
      constants: {
        PUBLISH_DIR: 'apps/my-app/.next',
      },
    } as NetlifyPluginOptions)
    return { ...mockFS, reqServerFiles, reqServerPathStandalone, ctx }
  },
  get simpleWithNodeMiddleware() {
    const reqServerFiles = JSON.stringify({
      config: { distDir: '.next' },
      relativeAppDir: '',
    } as RequiredServerFilesManifest)
    const reqServerPath = '.next/required-server-files.json'
    const reqServerPathStandalone = join('.next/standalone', reqServerPath)
    const functionsConfigManifestPath =
      '.next/standalone/.next/server/functions-config-manifest.json'
    const buildIDPath = join('.netlify/functions-internal/___netlify-server-handler/.next/BUILD_ID')
    mockFS = mockFileSystem({
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [reqServerPath.replace('required-server-files.json', 'prerender-manifest.json')]:
        '{"routes":{}}',
      [functionsConfigManifestPath]: JSON.stringify({
        version: 1,
        functions: {
          '/_middleware': {
            runtime: 'nodejs',
            matchers: [{ regexp: '^/(?:.*)$', originalSource: '/:path*' }],
          },
        },
      }),
      [buildIDPath]: 'build-id',
    })
    const ctx = new PluginContext({ ...mockPluginOptions, constants: {} } as NetlifyPluginOptions)
    return { ...mockFS, ctx }
  },
  get turbopackPagesRouter() {
    const reqServerFiles = JSON.stringify({
      config: { distDir: '.next' },
      relativeAppDir: '',
    } as RequiredServerFilesManifest)
    const reqServerPath = '.next/required-server-files.json'
    const reqServerPathStandalone = join('.next/standalone', reqServerPath)
    const buildIDPath = join('.netlify/functions-internal/___netlify-server-handler/.next/BUILD_ID')
    const serverDir = '.next/standalone/.next/server'
    mockFS = mockFileSystem({
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [buildIDPath]: 'build-id',
      [reqServerPath.replace('required-server-files.json', 'prerender-manifest.json')]:
        JSON.stringify({
          routes: {
            '/blog/hello': { dataRoute: '/_next/data/build-id/blog/hello.json' },
          },
        }),
      // page template, and the per-page manifests Turbopack emits in a directory next to it
      [`${serverDir}/pages/blog/[slug].js`]: 'page',
      [`${serverDir}/pages/blog/[slug]/react-loadable-manifest.json`]: '{}',
      [`${serverDir}/pages/blog/[slug]/build-manifest.json`]: '{}',
      // file tracing output for that template, only consumed by the build
      [`${serverDir}/pages/blog/[slug].js.nft.json`]: '{"files":[]}',
      // prerendered page - its data is seeded into the blob store, not read by the server handler
      [`${serverDir}/pages/blog/hello.html`]: '<html></html>',
      [`${serverDir}/pages/blog/hello.json`]: '{"pageProps":{}}',
    })
    const ctx = new PluginContext({ ...mockPluginOptions, constants: {} } as NetlifyPluginOptions)
    return {
      ...mockFS,
      ctx,
      handlerPagesDir:
        '.netlify/functions-internal/___netlify-server-handler/.next/server/pages/blog',
    }
  },
  get simpleMissingBuildID() {
    const reqServerFiles = JSON.stringify({
      config: { distDir: '.next' },
      relativeAppDir: 'apps/my-app',
    } as RequiredServerFilesManifest)
    const reqServerPath = 'apps/my-app/.next/required-server-files.json'
    const reqServerPathStandalone = join('apps/my-app/.next/standalone', reqServerPath)
    mockFS = mockFileSystem({
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [reqServerPath.replace('required-server-files.json', 'prerender-manifest.json')]:
        '{"routes":{}}',
    })
    const ctx = new PluginContext({
      ...mockPluginOptions,
      constants: {
        PACKAGE_PATH: 'apps/my-app',
      },
    } as NetlifyPluginOptions)
    return { ...mockFS, reqServerFiles, reqServerPathStandalone, ctx }
  },
}

beforeEach(() => {
  mockFS = undefined
  mockFailBuild.mockReset().mockImplementation(() => {
    expect.fail('failBuild should not be called')
  })
})

describe('copyNextServerCode', () => {
  test('should not modify the required-server-files.json distDir on simple next app', async () => {
    const { cwd, ctx, reqServerPathStandalone, reqServerFiles } = fixtures.simple
    await copyNextServerCode(ctx)
    expect(await readFile(join(cwd, reqServerPathStandalone), 'utf-8')).toBe(reqServerFiles)
  })

  test('should not modify the required-server-files.json distDir on monorepo', async () => {
    const { cwd, ctx, reqServerPathStandalone, reqServerFiles } = fixtures.monorepo
    await copyNextServerCode(ctx)
    expect(await readFile(join(cwd, reqServerPathStandalone), 'utf-8')).toBe(reqServerFiles)
  })

  // case of nx-integrated
  test('should modify the required-server-files.json distDir on distDir outside of packagePath', async () => {
    const { cwd, ctx, reqServerPathStandalone } = fixtures.nxIntegrated
    await copyNextServerCode(ctx)
    expect(await readFile(join(cwd, reqServerPathStandalone), 'utf-8')).toBe(
      '{"config":{"distDir":".next"},"relativeAppDir":"apps/my-app"}',
    )
  })

  test('should disable Node.js middleware in functions-config-manifest.json before the server directory exists', async () => {
    const { cwd, ctx } = fixtures.simpleWithNodeMiddleware
    await copyNextServerCode(ctx)
    const manifest = JSON.parse(
      await readFile(
        join(
          cwd,
          '.netlify/functions-internal/___netlify-server-handler/.next/server/functions-config-manifest.json',
        ),
        'utf-8',
      ),
    )
    expect(manifest.functions['/_middleware'].matchers).toEqual([
      { regexp: '(?!.*)', originalSource: '/:path*' },
    ])
  })

  test('should copy per-page manifests, but not file tracing output or prerendered page data', async () => {
    const { cwd, ctx } = fixtures.turbopackPagesRouter
    await copyNextServerCode(ctx)

    const serverPagesDir = join(cwd, '.next/standalone/.next/server/pages')
    const copiedPages = vi
      .mocked(cp)
      .mock.calls.map(([srcPath]) => String(srcPath))
      .filter((srcPath) => srcPath.startsWith(serverPagesDir))
      .map((srcPath) => relative(serverPagesDir, srcPath))

    // file tracing output is only consumed by the build
    expect(copiedPages, 'file tracing output should not be copied').not.toContain(
      join('blog', '[slug].js.nft.json'),
    )
    // prerendered page data is seeded into the response cache instead
    expect(copiedPages, 'prerendered page data should not be copied').not.toContain(
      join('blog', 'hello.json'),
    )

    expect(copiedPages.sort()).toEqual([
      join('blog', '[slug].js'),
      join('blog/[slug]', 'build-manifest.json'),
      join('blog/[slug]', 'react-loadable-manifest.json'),
    ])
  })
})

describe('verifyHandlerDirStructure', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    mockFailBuild.mockImplementation(() => {})
  })

  test('should not fail build on simple next app', async () => {
    const { ctx } = fixtures.simple
    await copyNextServerCode(ctx)
    await verifyHandlerDirStructure(ctx)
    expect(mockFailBuild).not.toHaveBeenCalled()
  })

  test('should not fail build on monorepo', async () => {
    const { ctx } = fixtures.monorepo
    await copyNextServerCode(ctx)
    await verifyHandlerDirStructure(ctx)
    expect(mockFailBuild).not.toHaveBeenCalled()
  })

  // case of nx-integrated
  test('should not fail build on distDir outside of packagePath', async () => {
    const { ctx } = fixtures.nxIntegrated
    await copyNextServerCode(ctx)
    await verifyHandlerDirStructure(ctx)
    expect(mockFailBuild).not.toHaveBeenCalled()
  })

  // case of misconfigured monorepo (no PACKAGE_PATH)
  test('should not fail build in monorepo with PACKAGE_PATH missing', async () => {
    const { ctx } = fixtures.monorepoMissingPackagePath
    await copyNextServerCode(ctx)
    await verifyHandlerDirStructure(ctx)

    expect(mockFailBuild).not.toHaveBeenCalled()
  })

  // just missing BUILD_ID
  test('should fail build if BUILD_ID is missing', async () => {
    const { ctx } = fixtures.simpleMissingBuildID
    await copyNextServerCode(ctx)
    await verifyHandlerDirStructure(ctx)
    expect(mockFailBuild).toBeCalledTimes(1)
    expect(mockFailBuild).toHaveBeenCalledWith(
      `Failed creating server handler. BUILD_ID file not found at expected location "${join(
        process.cwd(),
        'apps/my-app/.netlify/functions-internal/___netlify-server-handler/apps/my-app/.next/BUILD_ID',
      )}".`,
      undefined,
    )
  })
})

describe(`getPatchesToApply`, () => {
  beforeEach(() => {
    delete process.env.NETLIFY_NEXT_FORCE_APPLY_ONGOING_PATCHES
  })
  test('ongoing: false', () => {
    const shouldPatchBeApplied = {
      '13.4.1': false, // before supported next version
      '13.5.1': true, // first stable supported version
      '14.1.4-canary.1': true, // canary version before stable with maxStableVersion - should be applied
      '14.1.4': true, // latest stable tested version
      '14.2.0': false, // untested stable version
      '14.2.0-canary.37': true, // maxVersion, should be applied
      '14.2.0-canary.38': false, // not ongoing patch so should not be applied
    }

    const nextModule = 'test'

    const patches: NextInternalModuleReplacement[] = [
      {
        ongoing: false,
        minVersion: '13.5.0-canary.0',
        maxVersion: '14.2.0-canary.37',
        nextModule,
        shimModule: 'not-used-in-test',
      },
    ]

    for (const [nextVersion, telemetryShimShouldBeApplied] of Object.entries(
      shouldPatchBeApplied,
    )) {
      const patchesToApply = getPatchesToApply(nextVersion, patches)
      const hasTelemetryShim = patchesToApply.some((patch) => patch.nextModule === nextModule)
      expect({ nextVersion, apply: hasTelemetryShim }).toEqual({
        nextVersion,
        apply: telemetryShimShouldBeApplied,
      })
    }
  })

  test('ongoing: true', () => {
    const shouldPatchBeApplied = {
      '13.4.1': false, // before supported next version
      '13.5.1': true, // first stable supported version
      '14.1.4-canary.1': true, // canary version before stable with maxStableVersion - should be applied
      '14.1.4': true, // latest stable tested version
      '14.2.0': false, // untested stable version
      '14.2.0-canary.38': true, // ongoing patch so should be applied on prerelease versions
    }

    const nextModule = 'test'

    const patches: NextInternalModuleReplacement[] = [
      {
        ongoing: true,
        minVersion: '13.5.0-canary.0',
        maxStableVersion: '14.1.4',
        nextModule,
        shimModule: 'not-used-in-test',
      },
    ]

    for (const [nextVersion, telemetryShimShouldBeApplied] of Object.entries(
      shouldPatchBeApplied,
    )) {
      const patchesToApply = getPatchesToApply(nextVersion, patches)
      const hasTelemetryShim = patchesToApply.some((patch) => patch.nextModule === nextModule)
      expect({ nextVersion, apply: hasTelemetryShim }).toEqual({
        nextVersion,
        apply: telemetryShimShouldBeApplied,
      })
    }
  })

  test('ongoing: true + NETLIFY_NEXT_FORCE_APPLY_ONGOING_PATCHES', () => {
    process.env.NETLIFY_NEXT_FORCE_APPLY_ONGOING_PATCHES = 'true'
    const shouldPatchBeApplied = {
      '13.4.1': false, // before supported next version
      '13.5.1': true, // first stable supported version
      '14.1.4-canary.1': true, // canary version before stable with maxStableVersion - should be applied
      '14.1.4': true, // latest stable tested version
      '14.2.0': true, // untested stable version but NETLIFY_NEXT_FORCE_APPLY_ONGOING_PATCHES is used
      '14.2.0-canary.38': true, // ongoing patch so should be applied on prerelease versions
    }

    const nextModule = 'test'

    const patches: NextInternalModuleReplacement[] = [
      {
        ongoing: true,
        minVersion: '13.5.0-canary.0',
        maxStableVersion: '14.1.4',
        nextModule,
        shimModule: 'not-used-in-test',
      },
    ]

    for (const [nextVersion, telemetryShimShouldBeApplied] of Object.entries(
      shouldPatchBeApplied,
    )) {
      const patchesToApply = getPatchesToApply(nextVersion, patches)
      const hasTelemetryShim = patchesToApply.some((patch) => patch.nextModule === nextModule)
      expect({ nextVersion, apply: hasTelemetryShim }).toEqual({
        nextVersion,
        apply: telemetryShimShouldBeApplied,
      })
    }
  })
})
