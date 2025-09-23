import type { NextAdapter } from 'next-with-adapters'

export type OnBuildCompleteContext = Parameters<Required<NextAdapter>['onBuildComplete']>[0]
export type NextConfigComplete = OnBuildCompleteContext['config']
