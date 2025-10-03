export default function NotFound({ timestamp }) {
  return (
    <p data-testid="custom-404">
      Custom 404 page with revalidate: <pre data-testid="timestamp">{timestamp}</pre>
    </p>
  )
}

/** @type {import('next').GetStaticProps} */
export const getStaticProps = ({ locale }) => {
  return {
    props: {
      timestamp: Date.now(),
    },
    revalidate: 300,
  }
}
