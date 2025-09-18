export default function Page() {
  return (
    <>
      <h1>Skew Protection Testing</h1>
      <nav>
        <ul>
          {
            // this is not used in tests, just general index page so it doesn't 404
            // test fixtures are available in dedicated pages for them
          }
          <li>
            <a href="/app-router">App Router</a>
          </li>
          <li>
            <a href="/pages-router">Pages Router</a>
          </li>
          <li>
            <a href="/middleware">Middleware</a>
          </li>
          <li>
            <a href="/next-config">next.config.js</a>
          </li>
          <li>
            <a href="/dynamic-import">Dynamic import</a>
          </li>
        </ul>
      </nav>
    </>
  )
}
