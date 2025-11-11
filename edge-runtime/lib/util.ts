/**
 * Normalize a data URL into a route path.
 * @see https://github.com/vercel/next.js/blob/25e0988e7c9033cb1503cbe0c62ba5de2e97849c/packages/next/src/shared/lib/router/utils/get-next-pathname-info.ts#L69-L76
 */
// export function normalizeDataUrl(urlPath: string) {
//   if (urlPath.startsWith('/_next/data/') && urlPath.includes('.json')) {
//     const paths = urlPath
//       .replace(/^\/_next\/data\//, '')
//       .replace(/\.json/, '')
//       .split('/')

//     urlPath = paths[1] !== 'index' ? `/${paths.slice(1).join('/')}` : '/'
//   }

//   return urlPath
// }

// export const removeBasePath = (path: string, basePath?: string) => {
//   if (basePath && path.startsWith(basePath)) {
//     return path.replace(basePath, '')
//   }
//   return path
// }

// export const addBasePath = (path: string, basePath?: string) => {
//   if (basePath && !path.startsWith(basePath)) {
//     return `${basePath}${path}`
//   }
//   return path
// }

// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/i18n/normalize-locale-path.ts

/**
 * This is how Next handles rewritten URLs.
 */
export function relativizeURL(url: string | string, base: string | URL) {
  const baseURL = typeof base === 'string' ? new URL(base) : base
  const relative = new URL(url, base)
  const origin = `${baseURL.protocol}//${baseURL.host}`
  return `${relative.protocol}//${relative.host}` === origin
    ? relative.toString().replace(origin, '')
    : relative.toString()
}

// export const normalizeIndex = (path: string) => (path === '/' ? '/index' : path)

// export const normalizeTrailingSlash = (path: string, trailingSlash?: boolean) =>
//   trailingSlash ? addTrailingSlash(path) : stripTrailingSlash(path)

// export const stripTrailingSlash = (path: string) =>
//   path !== '/' && path.endsWith('/') ? path.slice(0, -1) : path

// export const addTrailingSlash = (path: string) => (path.endsWith('/') ? path : `${path}/`)

/**
 * Modify a data url to point to a new page route.
 */
// export function rewriteDataPath({
//   dataUrl,
//   newRoute,
//   basePath,
// }: {
//   dataUrl: string
//   newRoute: string
//   basePath?: string
// }) {
//   const normalizedDataUrl = normalizeDataUrl(removeBasePath(dataUrl, basePath))

//   return addBasePath(
//     dataUrl.replace(
//       normalizeIndex(normalizedDataUrl),
//       stripTrailingSlash(normalizeIndex(newRoute)),
//     ),
//     basePath,
//   )
// }
