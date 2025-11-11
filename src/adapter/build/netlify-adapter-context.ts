import type { FrameworksAPIConfig } from './types.js'

type Revalidate = number | false

export type ISRCacheEntry = {
  /** body of initial response */
  content: string
  /**
   * initialStatus is the status code that should be applied
   * when serving the fallback
   */
  status?: number
  /**
   * initialHeaders are the headers that should be sent when
   * serving the fallback
   */
  headers?: Record<string, string>
  /**
   * initial expiration is how long until the fallback entry
   * is considered expired and no longer valid to serve
   */
  expiration?: number
  /**
   * initial revalidate is how long until the fallback is
   * considered stale and should be revalidated
   */
  revalidate?: Revalidate
}

export type ISRDef = {
  pathname: string
  queryParams: string[]
  fallback?: ISRCacheEntry
}

export function createNetlifyAdapterContext() {
  return {
    frameworksAPIConfig: undefined as FrameworksAPIConfig | undefined,
    preparedOutputs: {
      staticAssets: [] as string[],
      staticAssetsAliases: {} as Record<string, string>,
      endpoints: {} as Record<
        string,
        { entry: string; id: string } & ({ type: 'function' } | { type: 'isr'; isrGroup: number })
      >,
      isrGroups: {} as Record<number, ISRDef[]>,
      middleware: false,
    },
  }
}
