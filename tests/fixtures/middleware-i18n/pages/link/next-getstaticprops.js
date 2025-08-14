export default function Page({ locale, locales }) {
  return (
    <div data-page="NextResponse.next()#getStaticProps">
      <h1>
        <code>getStaticProps</code> page
      </h1>
      <dt>Current locale:</dt>
      <dd data-testid="current-locale">{locale ?? 'N/A'}</dd>
      <dt>All locales:</dt>
      <dd data-testid="all-locales">{locales ? locales.join(',') : 'N/A'}</dd>
    </div>
  )
}

/** @type {import('next').GetStaticProps} */
export function getStaticProps({ locale, locales }) {
  console.log('NextResponse.next()#getStaticProps', { locale, locales })
  return {
    props: {
      locale,
      locales,
    },
    revalidate: 5,
  }
}
