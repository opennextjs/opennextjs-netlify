#!/usr/bin/env bash
set -euo pipefail

# The Next.js harness captures this script's stdout+stderr as next.cliOutput
# (test/lib/next-modes/next-deploy.ts) and uses it two ways:
#   1. parseIdsFromCliOuput() extracts BUILD_ID / DEPLOYMENT_ID /
#      NEXT_SUPPORTS_IMMUTABLE_ASSETS via `.match(/… (.+)/)` — FIRST match wins.
#   2. tests read next.cliOutput to assert on build/deploy output (e.g.
#      deprecation warnings or build errors).
#
# We print NONE of those markers ourselves, on purpose. The fixture already prints all
# three: in deploy mode the harness appends `&& pnpm post-build` to whatever build
# script the fixture has, and that post-build echoes BUILD_ID, DEPLOYMENT_ID and
# NEXT_SUPPORTS_IMMUTABLE_ASSETS (test/lib/next-modes/base.ts). Since the build runs
# inside `netlify deploy`, those lines are already in .adapter-deploy.log below.
#
# We used to emit our own .adapter-deploy-metadata.log FIRST, so it won the first-match
# — and its DEPLOYMENT_ID was the Netlify deploy id, which is not what Next.js means by
# a deployment id at all. Next means the SKEW PROTECTION token: the value the runtime
# inlines into the bundle (NEXT_DEPLOYMENT_ID, set from NETLIFY_SKEW_PROTECTION_TOKEN in
# src/build/skew-protection.ts) and that skew tests send back as ?dpl= / x-deployment-id
# / the __vdpl cookie. post-build echoes exactly that, because it echoes
# process.env.NEXT_DEPLOYMENT_ID from inside the build. So the correct value was in the
# log the whole time, and our marker was shadowing it.
#
# The lesson generalises: don't restate what the harness already states. A second source
# for the same fact is a second source that can be wrong.
if [ -f ".adapter-deploy.log" ]; then
  echo "=== .adapter-deploy.log ==="
  cat ".adapter-deploy.log"
fi

if [ -f ".adapter-server.log" ]; then
  echo "=== .adapter-server.log ==="
  cat ".adapter-server.log"
fi
