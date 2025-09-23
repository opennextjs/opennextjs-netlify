## Feedback

- Files from `public` not in `outputs.staticFiles`
- In `onBuildComplete` - `config.images.remotePatterns` type is `(RemotePattern | URL)[]` but in
  reality `URL` inputs are converted to `RemotePattern` so type should be just `RemotePattern[]`

## Plan

1. There are some operations that are easier to do in a build plugin context due to helpers, so some
   handling will remain in build plugin (cache save/restore, moving static assets dirs for
   publishing them etc).

2. We will use adapters API where it's most helpful:

- adjusting next config:
  - set standalone mode instead of using "private" env var (for now at least we will continue with
    standalone mode as using outputs other than middleware require bigger changes which will be
    explored in later phases)
  - set image loader (url generator) to use Netlify Image CDN directly (no need for \_next/image
    rewrite then)
  - (maybe/explore) set build time cache handler to avoid having to read output of default cache
    handler and convert those files into blobs to upload later
- use middleware output to generate middleware edge function
- don't glob for static files and use `outputs.staticFiles` instead
- don't read various manifest files manually and use provided context in `onBuildComplete` instead

## To figure out

- Can we export build time otel spans from adapter similarly how we do that now in a build plugin?
- Expose some constants from build plugin to adapter - what's best way to do that? (things like
  packagePath, publishDir etc)
