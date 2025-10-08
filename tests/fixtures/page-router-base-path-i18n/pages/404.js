export default function NotFound({ locale }) {
  return (
    <p data-testid="custom-404">
      Custom 404 page for locale: <pre data-testid="locale">{locale}</pre>
    </p>
  )
}

/** @type {import('next').GetStaticProps} */
export const getStaticProps = ({ locale }) => {
  return {
    props: {
      locale,
    },
  }
}
