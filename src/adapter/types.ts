import type { NetlifyConfig } from '@netlify/build'
import type { NextAdapter } from 'next-with-adapters'

export type OnBuildCompleteContext = Parameters<Required<NextAdapter>['onBuildComplete']>[0]
export type NextConfigComplete = OnBuildCompleteContext['config']

export type FrameworksAPIConfig = Partial<
  Pick<NetlifyConfig, 'edge_functions' | 'functions' | 'headers' | 'redirects' | 'images'>
> | null
