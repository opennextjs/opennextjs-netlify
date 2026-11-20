import { actionOnlyUsedOnPageB } from './actions'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <form action={actionOnlyUsedOnPageB}>
      <button type="submit">Run action</button>
    </form>
  )
}
