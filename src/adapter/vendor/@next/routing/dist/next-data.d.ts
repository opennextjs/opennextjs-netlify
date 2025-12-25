/**
 * Normalizes Next.js data URL by removing /_next/data/{buildId}/ prefix and .json extension
 * ${basePath}/_next/data/$buildId/$path.json -> ${basePath}/$path
 */
export declare function normalizeNextDataUrl(url: URL, basePath: string, buildId: string): URL;
/**
 * Denormalizes URL by adding /_next/data/{buildId}/ prefix and .json extension
 * ${basePath}/$path -> ${basePath}/_next/data/$buildId/$path.json
 */
export declare function denormalizeNextDataUrl(url: URL, basePath: string, buildId: string): URL;
