import type { Context } from '@netlify/edge-functions'

import {
  addBasePath,
  addLocale,
  addTrailingSlash,
  normalizeDataUrl,
  normalizeLocalePath,
  removeBasePath,
  rewriteDataPath,
} from './util.ts'

interface I18NConfig {
  defaultLocale: string
  localeDetection?: false
  locales: string[]
}

export interface RequestData {
  geo?: {
    city?: string
    country?: string
    region?: string
    latitude?: string
    longitude?: string
    timezone?: string
  }
  headers: Record<string, string>
  ip?: string
  method: string
  nextConfig?: {
    basePath?: string
    i18n?: I18NConfig | null
    trailingSlash?: boolean
    skipMiddlewareUrlNormalize?: boolean
  }
  page?: {
    name?: string
    params?: { [key: string]: string }
  }
  url: string
  body?: ReadableStream<Uint8Array>
  detectedLocale?: string
}

const normalizeRequestURL = (
  originalURL: string,
  nextConfig?: RequestData['nextConfig'],
): { url: string; detectedLocale?: string } => {
  const url = new URL(originalURL)

  let pathname = removeBasePath(url.pathname, nextConfig?.basePath)

  // If it exists, remove the locale from the URL and store it
  const { detectedLocale } = normalizeLocalePath(pathname, nextConfig?.i18n?.locales)

  if (!nextConfig?.skipMiddlewareUrlNormalize) {
    // We want to run middleware for data requests and expose the URL of the
    // corresponding pages, so we have to normalize the URLs before running
    // the handler.
    pathname = normalizeDataUrl(pathname)

    // Normalizing the trailing slash based on the `trailingSlash` configuration
    // property from the Next.js config.
    if (nextConfig?.trailingSlash) {
      pathname = addTrailingSlash(pathname)
    }
  }

  url.pathname = addBasePath(pathname, nextConfig?.basePath)

  return {
    url: url.toString(),
    detectedLocale,
  }
}

export const localizeRequest = (
  url: URL,
  nextConfig?: {
    basePath?: string
    i18n?: I18NConfig | null
  },
): { localizedUrl: URL; locale?: string } => {
  const localizedUrl = new URL(url)
  const pathnameWithoutBasePath = removeBasePath(localizedUrl.pathname, nextConfig?.basePath)

  const isDataRequest = pathnameWithoutBasePath.startsWith('/_next/data/')

  const normalizedPath = isDataRequest
    ? normalizeDataUrl(pathnameWithoutBasePath)
    : pathnameWithoutBasePath

  // Detect the locale from the URL
  const { detectedLocale } = normalizeLocalePath(normalizedPath, nextConfig?.i18n?.locales)

  // Add the locale to the URL if not already present
  const normalizedPathWithLocale = addLocale(
    normalizedPath,
    detectedLocale ?? nextConfig?.i18n?.defaultLocale,
  )

  localizedUrl.pathname = addBasePath(
    isDataRequest
      ? rewriteDataPath({
          dataUrl: pathnameWithoutBasePath,
          newRoute: normalizedPathWithLocale,
        })
      : normalizedPathWithLocale,
    nextConfig?.basePath,
  )

  return {
    localizedUrl,
    locale: detectedLocale,
  }
}

export const buildNextRequest = (
  request: Request,
  context: Context,
  nextConfig?: RequestData['nextConfig'],
): RequestData => {
  const { url, method, body, headers } = request
  const { country, subdivision, city, latitude, longitude, timezone } = context.geo
  const geo: RequestData['geo'] = {
    city,
    country: country?.code,
    region: subdivision?.code,
    latitude: latitude?.toString(),
    longitude: longitude?.toString(),
    timezone,
  }

  const { detectedLocale, url: normalizedUrl } = normalizeRequestURL(url, nextConfig)

  return {
    headers: Object.fromEntries(headers.entries()),
    geo,
    url: normalizedUrl,
    method,
    ip: context.ip,
    body: body ?? undefined,
    nextConfig,
    detectedLocale,
  }
}
