/**
 * i18n utilities for locale detection and handling
 */
export interface I18nDomain {
    defaultLocale: string;
    domain: string;
    http?: true;
    locales?: string[];
}
export interface I18nConfig {
    defaultLocale: string;
    domains?: I18nDomain[];
    localeDetection?: false;
    locales: string[];
}
/**
 * Detects the domain locale based on hostname or detected locale
 */
export declare function detectDomainLocale(domains: I18nDomain[] | undefined, hostname: string | undefined, detectedLocale?: string): I18nDomain | undefined;
/**
 * Normalizes a pathname by removing the locale prefix if present
 */
export declare function normalizeLocalePath(pathname: string, locales: string[]): {
    pathname: string;
    detectedLocale?: string;
};
/**
 * Parses the Accept-Language header and returns the best matching locale
 */
export declare function getAcceptLanguageLocale(acceptLanguageHeader: string, locales: string[]): string | undefined;
/**
 * Gets the locale from the NEXT_LOCALE cookie
 */
export declare function getCookieLocale(cookieHeader: string | undefined, locales: string[]): string | undefined;
/**
 * Detects the appropriate locale based on path, domain, cookie, and accept-language
 */
export declare function detectLocale(params: {
    pathname: string;
    hostname: string | undefined;
    cookieHeader: string | undefined;
    acceptLanguageHeader: string | undefined;
    i18n: I18nConfig;
}): {
    locale: string;
    pathnameWithoutLocale: string;
    localeInPath: boolean;
};
