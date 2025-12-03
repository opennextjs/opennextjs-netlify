import depA from '@repo/dep-a'
import depB from '@repo/dep-b'

export default function TransitiveDeps() {
  return (
    <body>
      <ul>
        <li>
          dep-a uses lodash version 3.10.1 and we should see this version here:{' '}
          <span data-testId="dep-a-version">{depA}</span>
        </li>
        <li>
          dep-b uses lodash version 4.17.21 and we should see this version here:{' '}
          <span data-testId="dep-b-version">{depB}</span>
        </li>
      </ul>
    </body>
  )
}

// just to ensure this is rendered in runtime and not prerendered
export async function getServerSideProps() {
  return {
    props: {},
  }
}
