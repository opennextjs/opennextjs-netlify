import { satisfies } from 'semver'

const FRAMEWORKS_API_BUILD_VERSION = '>=29.41.5'

/**
 * Checks if the build is running with a version that supports the Frameworks API.
 * @param buildVersion The build version from the Netlify context.
 * @returns `true` if the build version supports the Frameworks API.
 */
export const shouldUseFrameworksAPI = (buildVersion: string): boolean =>
  satisfies(buildVersion, FRAMEWORKS_API_BUILD_VERSION, { includePrerelease: true })

/**
 * Defines the directory for serverless functions when using the Frameworks API.
 * @returns The path to the serverless functions directory.
 */
export const getFrameworksAPIFunctionsDir = () => '.netlify/v1/functions'

/**
 * Defines the directory for edge functions when using the Frameworks API.
 * @returns The path to the edge functions directory.
 */
export const getFrameworksAPIEdgeFunctionsDir = () => '.netlify/v1/edge-functions'

/**
 * Defines the directory for blobs when using the Frameworks API.
 * @returns The path to the blobs directory.
 */
export const getFrameworksAPIBlobsDir = () => '.netlify/v1/blobs/deploy'
