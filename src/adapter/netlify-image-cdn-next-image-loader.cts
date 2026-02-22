// this file is CJS because we add a `require` polyfill banner that attempt to use node:module in ESM modules
// this later cause problems because Next.js will use this file in browser context where node:module is not available
// ideally we would not add banner for this file and the we could make it ESM, but currently there is no conditional banners
// in esbuild, only workaround in form of this proof of concept https://www.npmjs.com/package/esbuild-plugin-transform-hook
// (or rolling our own esbuild plugin for that)

import type { ImageLoader } from 'next-with-adapters/dist/shared/lib/image-external.js'

const netlifyImageLoader: ImageLoader = ({ src, width, quality }) => {
  const url = new URL(`.netlify/images`, 'http://n')
  url.searchParams.set('url', src)
  url.searchParams.set('w', width.toString())
  url.searchParams.set('q', (quality || 75).toString())
  return url.pathname + url.search
}

export default netlifyImageLoader
