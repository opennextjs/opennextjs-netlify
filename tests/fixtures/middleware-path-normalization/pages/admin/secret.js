export const getServerSideProps = async ({ locale }) => {
  return { props: { secret: 'ADMIN-SECRET', locale: locale ?? null } }
}

export default function Secret({ secret }) {
  return <p>{secret}</p>
}
