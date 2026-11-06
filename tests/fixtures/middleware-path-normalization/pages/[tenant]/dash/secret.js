// dynamic segment before gated part of the path, to test matchers like `/:tenant/dash/:path*`
export const getServerSideProps = async ({ params, locale }) => {
  return { props: { secret: 'DASH-SECRET', tenant: params.tenant, locale: locale ?? null } }
}

export default function Secret({ secret }) {
  return <p>{secret}</p>
}
