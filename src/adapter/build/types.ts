import type { NetlifyConfig } from '@netlify/build'
import type { NextAdapter } from 'next-with-adapters'

import type { createNetlifyAdapterContext } from './netlify-adapter-context.js'

export type OnBuildCompleteContext = Parameters<Required<NextAdapter>['onBuildComplete']>[0]
export type NextConfigComplete = OnBuildCompleteContext['config']

export type FrameworksAPIConfig = Partial<
  Pick<NetlifyConfig, 'edge_functions' | 'functions' | 'headers' | 'redirects' | 'images'>
> | null

export type NetlifyAdapterContext = ReturnType<typeof createNetlifyAdapterContext>
