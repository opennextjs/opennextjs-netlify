## Feedback

- Files from `public` directory not listed in `outputs.staticFiles`. Should they be?
- `routes.headers` does not contain immutable cache-control headers for `_next/static`. Should those
  be included?
- In `onBuildComplete` - `config.images.remotePatterns` type is `(RemotePattern | URL)[]` but in
  reality `URL` inputs are converted to `RemotePattern` so type should be just `RemotePattern[]` in
  `onBuildComplete` (this would require different config type for `modifyConfig` (allow inputs
  here?) and `onBuildComplete` (final, normalized config shape)?)
- `outputs.middleware.config.matchers` can be undefined per types - can that ever happen? Can we
  just have empty array instead to simplify handling (possibly similar as above point where type is
  for the input, while "output" will have a default matcher if not defined by user).
- `outputs.middleware` does not contain `env` that exist in `middleware-manifest.json` (i.e.
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `NEXT_PREVIEW_MODE_ID`, `NEXT_PREVIEW_MODE_SIGNING_KEY` etc)
  or `wasm` (tho wasm files are included in assets, so I think I have a way to support those as-is,
  but need to to make some assumption about using extension-less file name of wasm file as
  identifier)
- `outputs.staticFiles` (i18n enabled) custom fully static (no `getStaticProps`) `/pages/*`
  `filePath` point to not existing file - see repro at https://github.com/pieh/i18n-adapters
- `outputs.staticFiles` (i18n enabled) custom `/pages/*` with `getStaticProps` result in fatal
  `Error: Invariant: failed to find source route /en(/*) for prerender /en(/*)` directly from
  Next.js:

  ```
  ⨯ Failed to run onBuildComplete from Netlify

    > Build error occurred
    Error: Invariant: failed to find source route /en/404 for prerender /en/404
  ```

  (additionally - invariant is reported as failing to run `onBuildComplete` from adapter, but it
  happens before adapter's `onBuildComplete` runs, would be good to clear this up a bit so users
  could report issues in correct place in such cases. Not that important for nearest future / not
  blocking).

  See repro at https://github.com/pieh/i18n-adapters (it's same as for point above, need to
  uncomment `getStaticProps` in one of the pages in repro to see this case)

- `output: 'export'` case seems to produce outputs as if it was not export mode (for example having
  non-empty `outputs.appPages` or `outputs.prerenders`). To not have special handling for that in
  adapters, only non-empty outputs should be `staticFiles` pointing to what's being written to `out`
  (or custom `distDir`) directory?
