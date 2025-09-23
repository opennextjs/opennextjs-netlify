import { join, relative } from 'node:path'

import { defineConfig } from 'vitest/config'
import { BaseSequencer, WorkspaceSpec } from 'vitest/node'
/**
 * Tests that might influence others and should run on an isolated executor (shard)
 * Needs to be relative paths to the repository root.
 */
const RUN_ISOLATED = new Set([
  join('tests', 'integration', 'fetch-handler.test.ts'),
  join('tests', 'integration', 'revalidate-path.test.ts'),
  join('tests', 'integration', 'cache-handler.test.ts'),
  join('tests', 'integration', 'edge-handler.test.ts'),
])

class Sequencer extends BaseSequencer {
  async shard(projects: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const {
      config: { shard: { index = 1, count = 1 } = {} },
    } = this.ctx

    if (count === 1) {
      console.log('[Sequencer]: No test sharding configured please specify with --shard 1/3')
      return projects
    }

    console.log(`[Sequencer]: Sharding configured to run on ${index}/${count}`)
    if (RUN_ISOLATED.size + 1 > count) {
      throw new Error(
        `[Sequencer]: The number of special tests + 1 for the remaining tests (${RUN_ISOLATED.size}) is larger than the node count (${count})
Increasing the node count of the sharding to --shard 1/${RUN_ISOLATED.size}`,
      )
    }

    const specialTests = projects.filter((project) =>
      RUN_ISOLATED.has(relative(process.cwd(), project[1])),
    )
    const regularTests = projects.filter(
      (project) => !RUN_ISOLATED.has(relative(process.cwd(), project[1])),
    )

    // Allocate the first nodes for special tests
    if (index <= specialTests.length) {
      return [specialTests[index - 1]]
    }

    // Distribute remaining tests on the remaining nodes
    if (index > specialTests.length && index <= count) {
      const remainingNodes = count - specialTests.length
      const bucketSize = Math.ceil(regularTests.length / remainingNodes)
      const startIndex = (index - specialTests.length - 1) * bucketSize
      const endIndex = startIndex + bucketSize
      return regularTests.slice(startIndex, endIndex)
    }

    return projects
  }
}

export default defineConfig({
  root: '.',
  test: {
    include: [],
    globals: true,
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    unstubEnvs: true,
    unstubGlobals: true,
    environment: 'node',
    testTimeout: 100_000,
    setupFiles: ['tests/test-setup.ts'],
    logHeapUsage: true,
    hookTimeout: 50_000,
    sequence: {
      sequencer: Sequencer,
    },
  },
  esbuild: {
    include: ['**/*.ts', '**/*.cts'],
    footer: `
    if (typeof __vite_ssr_import_meta__ !== 'undefined') {
      __vite_ssr_import_meta__.resolve = (path) => {
        return 'file://' + require.resolve(path.replace('.js', '.ts'));
      }
    }
    `,
  },
})
