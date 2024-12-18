import { revalidatePath } from 'next/cache'
import { after, connection } from 'next/server'

export default async function Page() {
  await connection()
  after(async () => {
    // this will run after response was sent
    console.log('after() triggered')
    console.log('after() sleep 1s')
    await new Promise((resolve) => setTimeout(resolve, 1000))

    console.log('after() revalidatePath /after/check')
    revalidatePath('/after/check')
  })

  return <div>Page with after()</div>
}
