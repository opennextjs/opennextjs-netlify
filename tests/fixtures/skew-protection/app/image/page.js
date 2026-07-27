'use client'

import Image from 'next/image'
import { useState } from 'react'

// Statically imported images are emitted by the bundler to
// /_next/static/media/<name>.<contenthash>.<ext>. The variant A and variant B copies of
// local-image.png differ, so the content hash - and therefore the URL - is different in each
// deploy. This is the case where next/image appends `&dpl=` to the /_next/image URL.
//
// Both variants of local-image.png are solid colours (variant A red, variant B blue) so that the
// tests can tell which deploy actually served the bytes - the images are otherwise the same size
// and, for the public/ one, live at the very same URL in both deploys.
import staticallyImportedImage from '../../public/local-image.png'

export default function Page() {
  const [showImages, setShowImages] = useState(false)

  return (
    <>
      <h1>Skew Protection Testing - next/image</h1>
      <p>
        Current variant: <span data-testid="current-variant">{process.env.SKEW_VARIANT}</span>
      </p>
      <p>
        Deployment id: <span data-testid="deployment-id">{process.env.NEXT_DEPLOYMENT_ID}</span>
      </p>
      <h2>
        <code>next/image</code>
      </h2>
      <div>
        {
          // Images are hidden initially for the same reason next/link links are on the other
          // pages: we only want them to start loading after the initial page load AND after
          // another deploy has been published. If they rendered right away they would be
          // fetched while the initial deploy is still the published one, which wouldn't
          // exercise skew protection at all.
        }
        <button data-testid="images-expand-button" onClick={() => setShowImages(!showImages)}>
          {showImages ? 'Hide images' : 'Show images'}
        </button>
        {showImages && (
          <>
            <h3>Statically imported image (/_next/static/media)</h3>
            <Image
              data-testid="statically-imported-image"
              src={staticallyImportedImage}
              alt="statically imported image"
            />
            {
              // Images referenced by path are served from public/ as-is. Their URL
              // (/local-image.png) is identical in every deploy, so next/image does NOT append
              // `&dpl=` to the /_next/image URL for them.
            }
            <h3>Image from public directory (not /_next/static/media)</h3>
            <Image
              data-testid="public-image"
              src="/local-image.png"
              alt="image from public directory"
              width={300}
              height={360}
            />
          </>
        )}
      </div>
    </>
  )
}
