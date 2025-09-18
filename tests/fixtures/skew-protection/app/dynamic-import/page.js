'use client'

import { useState } from 'react'

export default function Page() {
  const [dynamicallyImportedValue, setDynamicallyImportedValue] = useState(null)

  return (
    <>
      <h1>Skew Protection Testing - Dynamic import</h1>
      <p>
        Current variant: <span data-testid="current-variant">{process.env.SKEW_VARIANT}</span>
      </p>
      <h2>Dynamic import</h2>
      <div>
        <button
          data-testid="dynamic-import-button"
          onClick={async () => {
            setDynamicallyImportedValue(null)
            try {
              const { variant } = await import('./dynamically-imported-module')
              setDynamicallyImportedValue(variant)
            } catch (err) {
              console.error(err)
              setDynamicallyImportedValue('Error: ' + (err.message || err.toString()))
            }
          }}
        >
          Test dynamic import
        </button>
        {dynamicallyImportedValue && (
          <p>
            Dynamic import result:
            <span data-testid="dynamic-import-result">{dynamicallyImportedValue}</span>
          </p>
        )}
      </div>
    </>
  )
}
