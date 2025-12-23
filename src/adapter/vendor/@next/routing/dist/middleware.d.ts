import type { MiddlewareResult } from './types';
/**
 * Converts a middleware Response object to a MiddlewareResult.
 * This function processes middleware response headers and applies transformations
 * such as header overrides, rewrites, redirects, and refresh signals.
 *
 * @param response - The Response object returned from middleware
 * @param requestHeaders - The request Headers object to be mutated
 * @param url - The original request URL
 * @returns A MiddlewareResult object with processed headers and routing information
 */
export declare function responseToMiddlewareResult(response: Response, requestHeaders: Headers, url: URL): MiddlewareResult;
