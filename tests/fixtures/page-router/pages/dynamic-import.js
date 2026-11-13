import dynamic from 'next/dynamic'

// SSR is left on (the default), so the server has to know which chunks the dynamic component
// needs (via react-loadable-manifest.json) and send them with the page for hydration to match
const DynamicContent = dynamic(() => import('../components/dynamic-content'), {
  loading: () => <p data-testid="dynamic-loading">Loading...</p>,
})

export default function Page() {
  return (
    <main>
      <h1>Page with next/dynamic import</h1>
      <DynamicContent />
    </main>
  )
}

// Rendered on request, so it goes through the server handler
export function getServerSideProps() {
  return { props: {} }
}
