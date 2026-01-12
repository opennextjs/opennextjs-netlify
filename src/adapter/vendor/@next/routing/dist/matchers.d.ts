import type { RouteHas } from './types';
/**
 * Checks if all "has" conditions are satisfied
 */
export declare function checkHasConditions(has: RouteHas[] | undefined, url: URL, headers: Headers): {
    matched: boolean;
    captures: Record<string, string>;
};
/**
 * Checks if all "missing" conditions are satisfied (i.e., none of them match)
 */
export declare function checkMissingConditions(missing: RouteHas[] | undefined, url: URL, headers: Headers): boolean;
