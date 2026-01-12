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
- [done] use middleware output to generate middleware edge function
- [done] don't glob for static files and use `outputs.staticFiles` instead
- [checked, did not apply changes yet, due to question about this in feedback section] check
  `output: 'export'` case
- note any remaining manual manifest files reading in build plugin once everything that could be
  adjusted was handled

## To figure out

- Can we export build time otel spans from adapter similarly how we do that now in a build plugin?
- Expose some constants from build plugin to adapter - what's best way to do that? (things like
  packagePath, publishDir etc)
- Looking forward - Platform change to accept a list of files to upload to cdn (avoids file system
  operations such as `cp`)
- Looking forward - allow using regexes for static headers matcher (needed to apply next.config.js
  defined headers to apply to static assets)
