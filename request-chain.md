# Adapter request chain

Adapters receive information about output pathnames, but the Adapters API/specification does not
fully document how to stitch those outputs together to implement routing that matches Next.js
behavior.

This document describes the Next.js request chain logic for adapter implementers. It gathers
behavior observed in the Next.js runtime and Vercel adapters and documents required routing logic
that currently needs to be reverse-engineered. The document describes what logic must be applied,
but does not prescribe implementation details — it is up to implementers to decide where and how to
apply this logic in their specific adapter architecture.

**Note:** This document intentionally does not cover ISR/prerender grouping and revalidation or PPR
(Partial Prerendering) handling, as those belong to the details of prerender output handling and not
to routing or output matching logic.

Legend:

- `[onBuildComplete routes]`: information supplied to the adapter via its `onBuildComplete`
  callback. This information is site/application-specific.
- `[generic rules]`: Generic, non-site-specific routing behaviors that are not provided via the
  adapter's `onBuildComplete` callback and are not currently documented in the specification. Many
  of these rules are conditional — for example, they may only apply when the Pages router or App
  router is used, when middleware is enabled, when i18n is configured.

Routing rules:

1. Incoming request phase

   All incoming requests go through this phase first, before any output matching is attempted.

   Steps:
   1. `[onBuildComplete routes]` Priority redirects (trailing slash): if the request pathname's
      trailing slash doesn't match configuration, terminate with a redirect that adds or strips the
      trailing slash.
   2. `[generic rules]` If middleware/proxy is enabled and using the Pages router:
      1. If the request path matches `<basepath>/_next/data/<build_id>/<path>.json`, add the
         `x-next-data: 1` request header and continue.
      2. If the request path matches `<basepath>/_next/data/<build_id>/<path>.json`, rewrite the
         request path to `<basepath>/<path>` (index special case) and continue.
   3. `[generic rules]` If i18n is enabled:
      1. If locale domains are configured:
         1. Rewrite the pathname to ensure the correct locale for the matched domain is prefixed to
            the pathname (index special case) and continue.
         2. If locale detection is enabled and the request targets the index route (including
            locale-prefixed ones), detect the locale based on the `NEXT_LOCALE` cookie or
            `Accept-Language` header and redirect to the locale-specific domain. TODO: avoid
            redirect loops — only redirect when the current pathname is not already the expected
            pathname.
      2. If locale detection is enabled and the request targets the index route, detect locale based
         on the `NEXT_LOCALE` cookie or `Accept-Language` header and redirect to the locale-prefixed
         path (or root for default locale). TODO: avoid redirect loops.
      3. If the pathname has no locale prefix, add the default locale prefix to the pathname (index
         special case) and continue.
   4. `[onBuildComplete routes]` Collect headers (from `next.config`) that match current request
      conditions and apply them to the final response.
   5. `[onBuildComplete routes]` Non-priority redirects (from `next.config`). If matched, terminate.
   6. `[onBuildComplete routes]` If middleware matched: run middleware. Note: middleware responses
      may be non-terminal (they can rewrite the request or mutate headers). Implementers must handle
      `x-middleware-rewrite`, `x-middleware-next`, `x-middleware-override-headers`,
      `x-middleware-set-cookie`, and similar control headers.
   7. `[onBuildComplete routes]` Run `beforeFiles` rewrites (from `next.config`); on a match,
      continue.
   8. `[generic rules]` Ensure that `/404` or `/<locale>/404` (if i18n enabled) routes return a 404
      status for non-revalidate requests, then continue.
   9. `[generic rules]` Ensure that `/500` or `/<locale>/500` (if i18n enabled) routes return a 500
      status for non-revalidate requests, then continue.
   10. `[generic rules]` If middleware/proxy is enabled and using the Pages router:
       1. If the request has the `x-next-data` header, rewrite the request path to
          `<basepath>/_next/data/<build_id>/<path>.json` (index special case) and continue — this
          undoes the `_next/data` path normalization done earlier.
   11. `[generic rules]` If App router behavior applies:
       1. Prefetch/segment handling is required here — it depends on multiple request headers and
          needs to be fleshed out (placeholder).
       2. If the request has an `rsc: 1` header, rewrite the request path to `<basepath>/<path>.rsc`
          (index special case) and continue.
   12. Proceed to the Output matching phase.

2. Output matching phase

   This phase executes potentially multiple times during the request chain. It's often invoked after
   applying a rewrite to check whether the rewrite resulted in a match on outputs.

   Steps:
   1. `[onBuildComplete routes]` Try to match outputs (other than middleware) or the `_next/image`
      image-optimization endpoint. Prioritize prerenders over functions if both exist for the same
      path. Terminate on a match. TODO: decide and document priority rules if static files,
      prerenders, and functions overlap — define priority or declare that any overlap is unexpected.
   2. `[generic rules]` Rewrite `<basepath>/_next/image` to `_next/image`. On a match, re-run output
      matching and terminate.
   3. `[generic rules]` If middleware/proxy + Pages router is enabled (normalizing again for
      rewrites in future steps):
      1. If the request path matches `<basepath>/_next/data/<build_id>/<path>.json`, rewrite the
         request path to `<basepath>/<path>` (index special case) and continue.
   4. `[generic rules]` If no middleware is present and the request path matches
      `<basepath>/_next/data/<build_id>/<path>.json`, try matching outputs again and terminate even
      if not matched (return a 404).
   5. `[generic rules]` If App router: rewrite `<basepath>/index.(rsc|action)` to `/` to normalize
      `/index` for rewrite matching. TODO: clarify prefetch/segment interactions.
   6. `[onBuildComplete routes]` Run `afterFiles` rewrites (from `next.config`); on a match, re-run
      output matching and terminate.
   7. `[generic rules]` If App router (fixing "bad rewrites"):
      1. Rewrite `<basepath>/.prefetch.rsc` to `<basepath>/__index.prefetch.rsc` and re-run the
         filesystem phase on a match.
      2. Rewrite `<basepath>/<path>/.prefetch.rsc` to `<basepath>/<path>.prefetch.rsc` and re-run
         the filesystem phase on a match.
      3. Rewrite `<basepath>/.rsc` to `<basepath>/index.rsc` and re-run the filesystem phase on a
         match.
      4. Rewrite `<basepath>/<path>/.rsc` to `<basepath>/<path>.rsc` and re-run the filesystem phase
         on a match.
   8. `[generic rules]` Rewrite `<basepath>/_next/static/<path>` to
      `<basepath>/_next/static/not-found.txt` and assign a 404 status code. On a match, re-run
      output matching and terminate.
   9. `[generic rules]` If i18n is enabled:
      1. Strip the locale prefix from the path and try matching on outputs again; terminate on a
         match.
   10. `[generic rules]` If middleware/proxy is enabled and using the Pages router:
       1. If the request has the `x-next-data` header, rewrite the request path to
          `<basepath>/_next/data/<build_id>/<path>.json` (index special case) and continue — this
          undoes the `_next/data` path normalization done earlier.
   11. `[onBuildComplete routes]` Try to match on dynamic route rewrites (from `next.config`). On a
       match, check outputs again and terminate.
   12. `[onBuildComplete routes]` Apply fallback rewrites (from `next.config`). On a match, check
       outputs again and terminate.
   13. `[generic rules]` No outputs matched — return a 404 status.

3. Termination

   After the request chain terminates (an output matched or a final status determined), apply
   additional transformations to the final response before returning it to the client.

   Steps:
   1. `[generic rules]` If a matched output returns a non-error response:
      1. If serving from `<basepath>/_next/static` (static files), apply
         `Cache-Control: public, max-age=31536000, immutable` response header.
      2. Apply an `x-matched-path` response header with the matched pathname.
   2. `[generic rules]` If no output matched or a 404 response was selected:
      1. Serve a custom 404 page if defined in outputs:
         1. If i18n + Pages router: `/<basepath>/<locale>/404` (based on the pathname locale) or
            `/<basepath>/<default-locale>/404` (if no locale in pathname).
         2. If no i18n + Pages router: `/<basepath>/404`.
         3. If App router: `/<basepath>/_not-found`.
      2. Serve a generic 404 page if no custom page is defined.
   3. `[generic rules]` If a matched output produced a 5xx response or output execution failed:
      1. Serve a custom 500 page if defined in outputs:
         1. If i18n + Pages router: `/<basepath>/<locale>/500` (based on the pathname locale) or
            `/<basepath>/<default-locale>/500` (if no locale in pathname).
         2. If no i18n + Pages router: `/<basepath>/500`.
         3. If App router: `/<basepath>/_error`.
      2. Serve a generic 500 page if no custom page is defined.
