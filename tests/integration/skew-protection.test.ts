import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { FixtureTestContext } from '../utils/contexts.js'

describe('skew protection', () => {
  let ctx: FixtureTestContext

  beforeAll(async () => {
    ctx = new FixtureTestContext({
      name: 'skew-protection',
      env: {
        NEXT_SKEW_PROTECTION_ENABLED: '1',
        NETLIFY_DEPLOY_ID: 'test-deploy-123',
      },
    })
    await ctx.setUp()
  })

  afterAll(async () => {
    await ctx.tearDown()
  })

  test('sets VERCEL_DEPLOYMENT_ID during build', async () => {
    const { publishDir } = ctx
    const requiredServerFiles = join(publishDir, 'required-server-files.json')
    
    // Check that the deployment ID was set during build
    expect(process.env.VERCEL_DEPLOYMENT_ID).toBe('test-deploy-123')
  })

  test('creates skew protection edge function', async () => {
    const { edgeFunctionsDir } = ctx
    const skewProtectionDir = join(edgeFunctionsDir, '___netlify-skew-protection')
    const skewProtectionFile = join(skewProtectionDir, '___netlify-skew-protection.js')
    
    // Check that the skew protection edge function was created
    expect(() => ctx.fs.readFileSync(skewProtectionFile, 'utf8')).not.toThrow()
    
    const content = ctx.fs.readFileSync(skewProtectionFile, 'utf8')
    expect(content).toContain('SKEW_PROTECTION_COOKIE')
    expect(content).toContain('DEPLOYMENT_ID_HEADER')
    expect(content).toContain('DEPLOYMENT_ID_QUERY_PARAM')
  })

  test('includes skew protection in edge functions manifest', async () => {
    const { edgeFunctionsDir } = ctx
    const manifestFile = join(edgeFunctionsDir, 'manifest.json')
    
    const manifestContent = ctx.fs.readFileSync(manifestFile, 'utf8')
    const manifest = JSON.parse(manifestContent)
    
    // Check that skew protection handler is in the manifest
    const skewProtectionFunction = manifest.functions.find(
      (fn: any) => fn.function === '___netlify-skew-protection'
    )
    
    expect(skewProtectionFunction).toBeDefined()
    expect(skewProtectionFunction.name).toBe('Next.js Skew Protection Handler')
    expect(skewProtectionFunction.pattern).toBe('^.*$')
    expect(skewProtectionFunction.cache).toBe('manual')
  })

  test('API route has access to deployment ID', async () => {
    const { url } = ctx
    const response = await fetch(`${url}/api/test`)
    const data = await response.json()
    
    expect(data.deploymentId).toBe('test-deploy-123')
  })
})