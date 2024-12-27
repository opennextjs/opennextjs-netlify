const { platform } = require('process')
const fsPromises = require('fs/promises')

// Next.js uses `fs.promises.copyFile` to copy files from `.next`to the `.next/standalone` directory
// It tries copying the same file twice in parallel. Unix is fine with that, but Windows fails
// with "Resource busy or locked", failing the build.
// We work around this by memoizing the copy operation, so that the second copy is a no-op.
// Tracked in TODO: report to Next.js folks
if (platform === 'win32') {
  const copies = new Map()

  const originalCopy = fsPromises.copyFile
  fsPromises.copyFile = (src, dest, mode) => {
    const key = `${dest}:${src}`
    const existingCopy = copies.get(key)
    if (existingCopy) return existingCopy

    const copy = originalCopy(src, dest, mode)
    copies.set(key, copy)
    return copy
  }
}

/** @type {import('next').NextConfig} */
module.exports = {
  trailingSlash: true,
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  generateBuildId: () => 'build-id',
  redirects() {
    return [
      {
        source: '/redirect-1',
        destination: '/somewhere/else/',
        permanent: false,
      },
    ]
  },
  rewrites() {
    return [
      {
        source: '/rewrite-1',
        destination: '/ssr-page?from=config',
      },
      {
        source: '/rewrite-2',
        destination: '/about/a?from=next-config',
      },
      {
        source: '/sha',
        destination: '/shallow',
      },
      {
        source: '/rewrite-3',
        destination: '/blog/middleware-rewrite?hello=config',
      },
    ]
  },
}
