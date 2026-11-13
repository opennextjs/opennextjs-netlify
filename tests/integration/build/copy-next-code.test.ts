import { join } from 'node:path'

import { NetlifyPluginOptions } from '@netlify/build'
import { expect, test } from 'vitest'

import { readFile, readdir } from 'node:fs/promises'
import { copyNextServerCode } from '../../../src/build/content/server.js'
import { PluginContext, RequiredServerFilesManifest } from '../../../src/build/plugin-context.js'
import { type FixtureTestContext } from '../../utils/contexts.js'
import { createFsFixture } from '../../utils/fixture.js'

// `copyNextServerCode` reads the prerender manifest to tell which page data files the server
// handler doesn't need; every real build emits one, so these fixtures have to as well
const EMPTY_PRERENDER_MANIFEST = JSON.stringify({ routes: {} })

test<FixtureTestContext>('should copy the next standalone folder correctly for a simple site', async (ctx) => {
  const reqServerFiles = JSON.stringify({
    config: { distDir: '.next' },
    relativeAppDir: '',
  } as RequiredServerFilesManifest)
  const reqServerPath = '.next/required-server-files.json'
  const prerenderManifestPath = '.next/prerender-manifest.json'
  const reqServerPathStandalone = join('.next/standalone', reqServerPath)
  const { cwd } = await createFsFixture(
    {
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [prerenderManifestPath]: EMPTY_PRERENDER_MANIFEST,
    },
    ctx,
  )
  const pluginCtx = new PluginContext({
    constants: { PUBLISH_DIR: '.next' },
  } as NetlifyPluginOptions)
  await copyNextServerCode(pluginCtx)

  expect(
    await readdir(join(cwd, '.netlify/functions-internal/___netlify-server-handler/.next')),
  ).toEqual(['required-server-files.json'])
})

test<FixtureTestContext>('should copy the next standalone folder correctly based on a custom dist dir', async (ctx) => {
  const reqServerFiles = JSON.stringify({
    config: { distDir: 'out/dir' },
    relativeAppDir: '',
  } as RequiredServerFilesManifest)
  const reqServerPath = 'out/dir/required-server-files.json'
  const prerenderManifestPath = 'out/dir/prerender-manifest.json'
  const reqServerPathStandalone = join('out/dir/standalone', reqServerPath)
  const { cwd } = await createFsFixture(
    {
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [prerenderManifestPath]: EMPTY_PRERENDER_MANIFEST,
    },
    ctx,
  )
  const pluginCtx = new PluginContext({
    constants: { PUBLISH_DIR: 'out/dir' },
  } as NetlifyPluginOptions)
  await copyNextServerCode(pluginCtx)

  expect(
    await readdir(join(cwd, '.netlify/functions-internal/___netlify-server-handler/out/dir')),
  ).toEqual(['required-server-files.json'])
})

test<FixtureTestContext>('should copy the next standalone folder correctly for monorepo', async (ctx) => {
  const reqServerFiles = JSON.stringify({
    config: { distDir: '.next' },
    relativeAppDir: 'apps/my-app',
  } as RequiredServerFilesManifest)
  const reqServerPath = 'apps/my-app/.next/required-server-files.json'
  const prerenderManifestPath = 'apps/my-app/.next/prerender-manifest.json'
  const reqServerPathStandalone = join('apps/my-app/.next/standalone', reqServerPath)
  const { cwd } = await createFsFixture(
    {
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [prerenderManifestPath]: EMPTY_PRERENDER_MANIFEST,
    },
    ctx,
  )
  const pluginCtx = new PluginContext({
    constants: { PUBLISH_DIR: 'apps/my-app/.next', PACKAGE_PATH: 'apps/my-app' },
  } as NetlifyPluginOptions)
  await copyNextServerCode(pluginCtx)

  expect(
    await readdir(
      join(
        cwd,
        'apps/my-app/.netlify/functions-internal/___netlify-server-handler/apps/my-app/.next',
      ),
    ),
  ).toEqual(['required-server-files.json'])
})

test<FixtureTestContext>('should copy the next standalone folder correctly for monorepo (without PACKAGE_PATH set)', async (ctx) => {
  const reqServerFiles = JSON.stringify({
    config: { distDir: '.next' },
    relativeAppDir: 'apps/my-app',
  } as RequiredServerFilesManifest)
  const reqServerPath = 'apps/my-app/.next/required-server-files.json'
  const prerenderManifestPath = 'apps/my-app/.next/prerender-manifest.json'
  const reqServerPathStandalone = join('apps/my-app/.next/standalone', reqServerPath)
  const { cwd } = await createFsFixture(
    {
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [prerenderManifestPath]: EMPTY_PRERENDER_MANIFEST,
    },
    ctx,
  )
  const pluginCtx = new PluginContext({
    constants: { PUBLISH_DIR: 'apps/my-app/.next' },
  } as NetlifyPluginOptions)
  await copyNextServerCode(pluginCtx)

  expect(
    await readdir(
      join(cwd, '.netlify/functions-internal/___netlify-server-handler/apps/my-app/.next'),
    ),
  ).toEqual(['required-server-files.json'])
})

test<FixtureTestContext>('should copy the next standalone folder correctly for monorepo with custom dir', async (ctx) => {
  const reqServerFiles = JSON.stringify({
    config: { distDir: 'deep/out/dir' },
    relativeAppDir: 'apps/my-app',
  } as RequiredServerFilesManifest)
  const reqServerPath = 'apps/my-app/deep/out/dir/required-server-files.json'
  const prerenderManifestPath = 'apps/my-app/deep/out/dir/prerender-manifest.json'
  const reqServerPathStandalone = join('apps/my-app/deep/out/dir/standalone', reqServerPath)
  const { cwd } = await createFsFixture(
    {
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [prerenderManifestPath]: EMPTY_PRERENDER_MANIFEST,
    },
    ctx,
  )
  const pluginCtx = new PluginContext({
    constants: { PUBLISH_DIR: 'apps/my-app/deep/out/dir', PACKAGE_PATH: 'apps/my-app' },
  } as NetlifyPluginOptions)
  await copyNextServerCode(pluginCtx)

  const nextDir = join(
    cwd,
    'apps/my-app/.netlify/functions-internal/___netlify-server-handler/apps/my-app/deep/out/dir',
  )
  expect(await readdir(nextDir)).toEqual(['required-server-files.json'])
  expect(await readFile(join(nextDir, 'required-server-files.json'), 'utf-8')).toBe(reqServerFiles)
})

test<FixtureTestContext>('should copy the next standalone folder correctly for monorepo with custom dir (without PACKAGE_PATH set)', async (ctx) => {
  const reqServerFiles = JSON.stringify({
    config: { distDir: 'deep/out/dir' },
    relativeAppDir: 'apps/my-app',
  } as RequiredServerFilesManifest)
  const reqServerPath = 'apps/my-app/deep/out/dir/required-server-files.json'
  const prerenderManifestPath = 'apps/my-app/deep/out/dir/prerender-manifest.json'
  const reqServerPathStandalone = join('apps/my-app/deep/out/dir/standalone', reqServerPath)
  const { cwd } = await createFsFixture(
    {
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [prerenderManifestPath]: EMPTY_PRERENDER_MANIFEST,
    },
    ctx,
  )
  const pluginCtx = new PluginContext({
    constants: { PUBLISH_DIR: 'apps/my-app/deep/out/dir' },
  } as NetlifyPluginOptions)
  await copyNextServerCode(pluginCtx)

  const nextDir = join(
    cwd,
    '.netlify/functions-internal/___netlify-server-handler/apps/my-app/deep/out/dir',
  )
  expect(await readdir(nextDir)).toEqual(['required-server-files.json'])
  expect(await readFile(join(nextDir, 'required-server-files.json'), 'utf-8')).toBe(reqServerFiles)
})

// case of nx-integrated
test<FixtureTestContext>('should copy the next standalone folder correctly in a monorepo based on a custom dist dir', async (ctx) => {
  const reqServerFiles = JSON.stringify({
    config: { distDir: '../../dist/apps/my-app/.next' },
    relativeAppDir: 'apps/my-app',
  } as RequiredServerFilesManifest)
  const reqServerPath = 'dist/apps/my-app/.next/required-server-files.json'
  const prerenderManifestPath = 'dist/apps/my-app/.next/prerender-manifest.json'
  const reqServerPathStandalone = join('dist/apps/my-app/.next/standalone', reqServerPath)
  const { cwd } = await createFsFixture(
    {
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [prerenderManifestPath]: EMPTY_PRERENDER_MANIFEST,
    },
    ctx,
  )
  const pluginCtx = new PluginContext({
    constants: {
      PACKAGE_PATH: 'apps/my-app',
      PUBLISH_DIR: 'dist/apps/my-app/.next',
    },
  } as NetlifyPluginOptions)
  await copyNextServerCode(pluginCtx)

  const nextDir = join(
    cwd,
    'apps/my-app/.netlify/functions-internal/___netlify-server-handler/dist/apps/my-app/.next',
  )
  expect(await readdir(nextDir)).toEqual(['required-server-files.json'])
  // config got updated to the .next folder
  expect(await readFile(join(nextDir, 'required-server-files.json'), 'utf-8')).toBe(
    '{"config":{"distDir":".next"},"relativeAppDir":"apps/my-app"}',
  )
})

// case of nx-integrated
test<FixtureTestContext>('should copy the next standalone folder correctly in a monorepo based on a custom dist dir (without PACKAGE_PATH)', async (ctx) => {
  const reqServerFiles = JSON.stringify({
    config: { distDir: '../../dist/apps/my-app/.next' },
    relativeAppDir: 'apps/my-app',
  } as RequiredServerFilesManifest)
  const reqServerPath = 'dist/apps/my-app/.next/required-server-files.json'
  const prerenderManifestPath = 'dist/apps/my-app/.next/prerender-manifest.json'
  const reqServerPathStandalone = join('dist/apps/my-app/.next/standalone', reqServerPath)
  const { cwd } = await createFsFixture(
    {
      [reqServerPath]: reqServerFiles,
      [reqServerPathStandalone]: reqServerFiles,
      [prerenderManifestPath]: EMPTY_PRERENDER_MANIFEST,
    },
    ctx,
  )
  const pluginCtx = new PluginContext({
    constants: {
      PUBLISH_DIR: 'dist/apps/my-app/.next',
    },
  } as NetlifyPluginOptions)
  await copyNextServerCode(pluginCtx)

  const nextDir = join(
    cwd,
    '.netlify/functions-internal/___netlify-server-handler/dist/apps/my-app/.next',
  )
  expect(await readdir(nextDir)).toEqual(['required-server-files.json'])
  // config got updated to the .next folder
  expect(await readFile(join(nextDir, 'required-server-files.json'), 'utf-8')).toBe(
    '{"config":{"distDir":".next"},"relativeAppDir":"apps/my-app"}',
  )
})
