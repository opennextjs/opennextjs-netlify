import Head from 'next/head'
import Link from 'next/link'
import styles from '../styles/Home.module.css'

export default function Home() {
  return (
    <div className={styles.container}>
      <Head>
        <title>Create Next App</title>
        <meta name="description" content="Generated by create next app" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className={styles.main}>
        <h1 className={styles.title}>
          Welcome to <a href="https://nextjs.org">Next.js!</a>
        </h1>

        <p>
          <Link href="/shows/rewriteme">Rewrite URL</Link>
        </p>
        <p>
          <Link href="/shows/rewrite-absolute">Rewrite to absolute URL</Link>
        </p>
        <p>
          <Link href="/shows/rewrite-external">Rewrite to external URL</Link>
        </p>
        <p>
          <Link href="/cookies" prefetch={false}>
            Cookie API
          </Link>
        </p>
      </main>
    </div>
  )
}
