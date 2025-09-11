import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Span } from '@opentelemetry/api'
import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest'

import type { PluginContext } from './plugin-context.js'
import { setSkewProtection, shouldEnableSkewProtection } from './skew-protection.js'

// Mock fs promises
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}))

// Mock path
vi.mock('node:path', () => ({
  dirname: vi.fn(),
}))

describe('shouldEnableSkewProtection', () => {
  let mockCtx: PluginContext
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env }

    // Reset env vars
    delete process.env.NETLIFY_NEXT_SKEW_PROTECTION
    // Set valid DEPLOY_ID by default
    process.env.DEPLOY_ID = 'test-deploy-id'

    mockCtx = {
      featureFlags: {},
      constants: {
        IS_LOCAL: false,
      },
    } as PluginContext

    vi.clearAllMocks()
  })

  afterEach(() => {
    // Restore original env
    process.env = originalEnv
  })

  describe('default behavior', () => {
    it('should return disabled by default', () => {
      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: false,
        enabledOrDisabledReason: 'off-default',
      })
    })
  })

  describe('environment variable opt-in', () => {
    it('should enable when NETLIFY_NEXT_SKEW_PROTECTION is "true"', () => {
      process.env.NETLIFY_NEXT_SKEW_PROTECTION = 'true'

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: true,
        enabledOrDisabledReason: 'on-env-var',
      })
    })

    it('should enable when NETLIFY_NEXT_SKEW_PROTECTION is "1"', () => {
      process.env.NETLIFY_NEXT_SKEW_PROTECTION = '1'

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: true,
        enabledOrDisabledReason: 'on-env-var',
      })
    })
  })

  describe('environment variable opt-out', () => {
    it('should disable when NETLIFY_NEXT_SKEW_PROTECTION is "false"', () => {
      process.env.NETLIFY_NEXT_SKEW_PROTECTION = 'false'

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: false,
        enabledOrDisabledReason: 'off-env-var',
      })
    })

    it('should disable when NETLIFY_NEXT_SKEW_PROTECTION is "0"', () => {
      process.env.NETLIFY_NEXT_SKEW_PROTECTION = '0'

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: false,
        enabledOrDisabledReason: 'off-env-var',
      })
    })
  })

  describe('feature flag opt-in', () => {
    it('should enable when feature flag is set', () => {
      mockCtx.featureFlags = { 'next-runtime-skew-protection': true }

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: true,
        enabledOrDisabledReason: 'on-ff',
      })
    })

    it('should not enable when feature flag is false', () => {
      mockCtx.featureFlags = { 'next-runtime-skew-protection': false }

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: false,
        enabledOrDisabledReason: 'off-default',
      })
    })
  })

  describe('DEPLOY_ID validation', () => {
    it('should disable when DEPLOY_ID is missing and not explicitly opted in', () => {
      mockCtx.featureFlags = { 'next-runtime-skew-protection': true }
      delete process.env.DEPLOY_ID

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: false,
        enabledOrDisabledReason: 'off-no-valid-deploy-id',
      })
    })

    it('should disable when DEPLOY_ID is "0" and not explicitly opted in', () => {
      mockCtx.featureFlags = { 'next-runtime-skew-protection': true }
      process.env.DEPLOY_ID = '0'

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: false,
        enabledOrDisabledReason: 'off-no-valid-deploy-id',
      })
    })

    it('should show specific reason when env var is set but DEPLOY_ID is invalid in local context', () => {
      process.env.NETLIFY_NEXT_SKEW_PROTECTION = 'true'
      process.env.DEPLOY_ID = '0'
      mockCtx.constants.IS_LOCAL = true

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: false,
        enabledOrDisabledReason: 'off-no-valid-deploy-id-env-var',
      })
    })
  })

  describe('precedence', () => {
    it('should prioritize env var opt-out over feature flag', () => {
      process.env.NETLIFY_NEXT_SKEW_PROTECTION = 'false'
      mockCtx.featureFlags = { 'next-runtime-skew-protection': true }

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: false,
        enabledOrDisabledReason: 'off-env-var',
      })
    })

    it('should prioritize env var opt-in over feature flag', () => {
      process.env.NETLIFY_NEXT_SKEW_PROTECTION = 'true'
      mockCtx.featureFlags = { 'next-runtime-skew-protection': false }

      const result = shouldEnableSkewProtection(mockCtx)

      expect(result).toEqual({
        enabled: true,
        enabledOrDisabledReason: 'on-env-var',
      })
    })
  })
})

describe('setSkewProtection', () => {
  let mockCtx: PluginContext
  let mockSpan: Span
  let originalEnv: NodeJS.ProcessEnv
  let consoleSpy: {
    log: MockInstance<typeof console.log>
    warn: MockInstance<typeof console.warn>
  }

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env }

    // Reset env vars
    delete process.env.NETLIFY_NEXT_SKEW_PROTECTION
    delete process.env.NEXT_DEPLOYMENT_ID
    // Set valid DEPLOY_ID by default
    process.env.DEPLOY_ID = 'test-deploy-id'

    mockCtx = {
      featureFlags: {},
      constants: {
        IS_LOCAL: false,
      },
      skewProtectionConfigPath: '/test/path/skew-protection.json',
    } as PluginContext

    mockSpan = {
      setAttribute: vi.fn(),
    } as unknown as Span

    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {
        /* no op */
      }),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {
        /* no op */
      }),
    }

    vi.clearAllMocks()
  })

  afterEach(() => {
    // Restore original env
    process.env = originalEnv
    consoleSpy.log.mockRestore()
    consoleSpy.warn.mockRestore()
  })

  it('should set span attribute and return early when disabled', async () => {
    await setSkewProtection(mockCtx, mockSpan)

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('skewProtection', 'off-default')
    expect(mkdir).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
    expect(consoleSpy.log).not.toHaveBeenCalled()
    expect(consoleSpy.warn).not.toHaveBeenCalled()
  })

  it('should show warning when env var is set but no valid DEPLOY_ID', async () => {
    process.env.NETLIFY_NEXT_SKEW_PROTECTION = 'true'
    process.env.DEPLOY_ID = '0'
    mockCtx.constants.IS_LOCAL = true

    await setSkewProtection(mockCtx, mockSpan)

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'skewProtection',
      'off-no-valid-deploy-id-env-var',
    )
    expect(consoleSpy.warn).toHaveBeenCalledWith(
      'NETLIFY_NEXT_SKEW_PROTECTION environment variable is set to true, but skew protection is currently unavailable for CLI deploys. Skew protection will not be enabled.',
    )
    expect(mkdir).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('should set up skew protection when enabled via env var', async () => {
    process.env.NETLIFY_NEXT_SKEW_PROTECTION = 'true'

    vi.mocked(dirname).mockReturnValue('/test/path')

    await setSkewProtection(mockCtx, mockSpan)

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('skewProtection', 'on-env-var')
    expect(consoleSpy.log).toHaveBeenCalledWith(
      'Setting up Next.js Skew Protection due to NETLIFY_NEXT_SKEW_PROTECTION=true environment variable.',
    )
    expect(process.env.NEXT_DEPLOYMENT_ID).toBe('test-deploy-id')
    expect(mkdir).toHaveBeenCalledWith('/test/path', { recursive: true })
    expect(writeFile).toHaveBeenCalledWith(
      '/test/path/skew-protection.json',
      JSON.stringify(
        {
          patterns: ['.*'],
          sources: [
            {
              type: 'cookie',
              name: '__vdpl',
            },
            {
              type: 'header',
              name: 'X-Deployment-Id',
            },
            {
              type: 'query',
              name: 'dpl',
            },
          ],
        },
        null,
        2,
      ),
    )
  })

  it('should set up skew protection when enabled via feature flag', async () => {
    mockCtx.featureFlags = { 'next-runtime-skew-protection': true }

    vi.mocked(dirname).mockReturnValue('/test/path')

    await setSkewProtection(mockCtx, mockSpan)

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('skewProtection', 'on-ff')
    expect(consoleSpy.log).toHaveBeenCalledWith('Setting up Next.js Skew Protection.')
    expect(process.env.NEXT_DEPLOYMENT_ID).toBe('test-deploy-id')
    expect(mkdir).toHaveBeenCalledWith('/test/path', { recursive: true })
    expect(writeFile).toHaveBeenCalledWith('/test/path/skew-protection.json', expect.any(String))
  })

  it('should handle different env var values correctly', async () => {
    process.env.NETLIFY_NEXT_SKEW_PROTECTION = '1'

    await setSkewProtection(mockCtx, mockSpan)

    expect(consoleSpy.log).toHaveBeenCalledWith(
      'Setting up Next.js Skew Protection due to NETLIFY_NEXT_SKEW_PROTECTION=1 environment variable.',
    )
  })
})
