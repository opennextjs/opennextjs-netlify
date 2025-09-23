## Feedback

- Files from `public` directory not listed in `outputs.staticFiles`
- In `onBuildComplete` - `config.images.remotePatterns` type is `(RemotePattern | URL)[]` but in
  reality `URL` inputs are converted to `RemotePattern` so type should be just `RemotePattern[]`
- `routes.headers` does not contain immutable cache-control headers for `_next/static`
- `outputs.middleware` does not contain env that exist in `middleware-manifest.json` (i.e.
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `NEXT_PREVIEW_MODE_ID`, `NEXT_PREVIEW_MODE_SIGNING_KEY` etc)
- `outputs.middleware.config.matchers` can be undefined per types - can that ever happen? Can we
  just have empty array instead to simplify handling.
- `outputs.staticFiles` (i18n enabled) custom fully static (no `getStaticProps`) `/pages/404.js`
  `filePath` point to not existing file (it doesn't have i18n locale prefix in `staticFiles` array,
  actual 404.html are written to i18n locale prefixed directories)
- `outputs.staticFiles` (i18n enabled) custom `/pages/404.js` with `getStaticProps` result in fatal
  `Error: Invariant: failed to find source route /en/404 for prerender /en/404` directly from
  Next.js:

  ```
  ⨯ Failed to run onBuildComplete from Netlify

    > Build error occurred
    Error: Invariant: failed to find source route /en/404 for prerender /en/404
  ```

  (additionally - invariant is reported as failing to run `onBuildComplete` from adapter, but it
  happens before adapter's `onBuildComplete` runs, would be good to clear this up a bit so users
  could report issues in correct place in such cases. Not that important for nearest future / not
  blocking)

## Plan

1. There are some operations that are easier to do in a build plugin context due to helpers, so some
   handling will remain in build plugin (cache save/restore, moving static assets dirs for
   publishing them etc).

2. We will use adapters API where it's most helpful:

- adjusting next config:
  - [done] set standalone mode instead of using "private" env var (for now at least we will continue
    with standalone mode as using outputs other than middleware require bigger changes which will be
    explored in later phases)
  - [done] set image loader (url generator) to use Netlify Image CDN directly (no need for
    \_next/image rewrite then)
  - (maybe/explore) set build time cache handler to avoid having to read output of default cache
    handler and convert those files into blobs to upload later
- [partially done - for edge runtime] use middleware output to generate middleware edge function
- [done] don't glob for static files and use `outputs.staticFiles` instead
- don't read various manifest files manually and use provided context in `onBuildComplete` instead

## To figure out

- Can we export build time otel spans from adapter similarly how we do that now in a build plugin?
- Expose some constants from build plugin to adapter - what's best way to do that? (things like
  packagePath, publishDir etc)
- Looking forward - Platform change to accept a list of files to upload to cdn (avoids file system
  operations such as `cp`)
- Looking forward - allow using regexes for static headers matcher (needed to apply next.config.js
  defined headers to apply to static assets)
