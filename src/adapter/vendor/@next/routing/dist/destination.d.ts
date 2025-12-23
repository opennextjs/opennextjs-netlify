/**
 * Replaces $1, $2, etc. and $name placeholders in the destination string
 * with matches from the regex and has conditions
 */
export declare function replaceDestination(destination: string, regexMatches: RegExpMatchArray | null, hasCaptures: Record<string, string>): string;
/**
 * Checks if a destination is an external rewrite (starts with http/https)
 */
export declare function isExternalDestination(destination: string): boolean;
/**
 * Applies a destination to a URL, updating the pathname or creating a new URL
 * if it's external
 */
export declare function applyDestination(currentUrl: URL, destination: string): URL;
/**
 * Checks if a status code is a redirect status code
 */
export declare function isRedirectStatus(status: number | undefined): boolean;
/**
 * Checks if headers contain redirect headers (Location or Refresh)
 */
export declare function hasRedirectHeaders(headers: Record<string, string>): boolean;
