export default function DestPathPage({ params }) {
  return (
    <div>
      <h1>Destination Page with Splat</h1>
      <p>Path: {params.path?.join('/') || ''}</p>
    </div>
  )
}
