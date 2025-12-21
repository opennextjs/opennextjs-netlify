import fs from 'node:fs'
import { afterEach } from 'vitest'
import { type FixtureTestContext } from './utils/contexts'

export async function afterTestCleanup({ cleanup }: FixtureTestContext) {
  if ('reset' in fs) {
    ;(fs as any).reset()
  }

  const jobs = (cleanup ?? []).map((job) => job())

  await Promise.all(jobs)
}

// cleanup after each test as a fallback if someone forgot to call it
afterEach<FixtureTestContext>(async (ctx) => {
  if (ctx.skipAutoCleanup !== true) {
    await afterTestCleanup(ctx)
  }
})
