export default function Page({ locale, locales }) {
  return (
    <div data-page="NextResponse.next()#getServerSideProps">
      <h1>
        <code>getServerSideProps</code> page
      </h1>
      <dt>Current locale:</dt>
      <dd data-testid="current-locale">{locale ?? 'N/A'}</dd>
      <dt>All locales:</dt>
      <dd data-testid="all-locales">{locales ? locales.join(',') : 'N/A'}</dd>
    </div>
  )
}

/** @type {import('next').GetServerSideProps} */
export function getServerSideProps({ locale, locales }) {
  console.log('NextResponse.next()#getServerSideProps', { locale, locales })
  return {
    props: {
      locale,
      locales,
    },
  }
}
