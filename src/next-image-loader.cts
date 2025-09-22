import type { ImageLoader } from 'next/dist/shared/lib/image-external.js'

const netlifyImageLoader: ImageLoader = ({ src, width, quality }) => {
  const url = new URL(`.netlify/images`, 'http://n')
  url.searchParams.set('url', src)
  url.searchParams.set('w', width.toString())
  url.searchParams.set('q', (quality || 75).toString())
  console.log(url)
  return url.pathname + url.search
}

export default netlifyImageLoader
