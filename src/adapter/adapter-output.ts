import type { AdapterOutput, NextAdapter } from 'next-with-adapters'

export const ADAPTER_OUTPUT_FILE = 'netlify-adapter-output.json'

/**
 * The context passed to `onBuildComplete`, extracted from the adapter type.
 */
export type AdapterBuildCompleteContext = NonNullable<
  Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0]
>

/**
 * Serialized adapter output written to `.next/netlify-adapter-output.json`.
 * This bridges the gap between Next.js build (where `onBuildComplete` runs)
 * and the Netlify plugin's `onBuild` hook.
 */
export interface SerializedAdapterOutput {
  routing: AdapterBuildCompleteContext['routing']
  outputs: {
    pages: Array<AdapterOutput['PAGES']>
    pagesApi: Array<AdapterOutput['PAGES_API']>
    appPages: Array<AdapterOutput['APP_PAGE']>
    appRoutes: Array<AdapterOutput['APP_ROUTE']>
    prerenders: Array<AdapterOutput['PRERENDER']>
    staticFiles: Array<AdapterOutput['STATIC_FILE']>
    middleware?: AdapterOutput['MIDDLEWARE']
  }
  projectDir: string
  repoRoot: string
  distDir: string
  config: AdapterBuildCompleteContext['config']
  nextVersion: string
  buildId: string
}
