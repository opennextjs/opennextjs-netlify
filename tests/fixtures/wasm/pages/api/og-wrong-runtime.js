// see next.config for details about 'next-og-alias'
import { ImageResponse } from 'next-og-alias'

export default function () {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 128,
          background: 'lavender',
        }}
      >
        Hello!
      </div>
    ),
  )
}
