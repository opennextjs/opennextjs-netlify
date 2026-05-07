import type { GetServerSideProps } from 'next'

export default function CatchAll({ data, locale }) {
  return (
    <>
      <div>
        Data: <span data-testid="data">{data}</span>
      </div>
      <div>
        Locale: <span data-testid="locale">{locale}</span>
      </div>
    </>
  )
}

export const getServerSideProps: GetServerSideProps = async ({ locale }) => {
  return {
    props: {
      data: 'data',
      locale: locale ?? 'not-i18n',
    },
  }
}
