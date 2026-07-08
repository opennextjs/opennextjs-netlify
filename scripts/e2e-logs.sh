#!/usr/bin/env bash
set -euo pipefail

# The Next.js harness captures this script's stdout+stderr as next.cliOutput
# (test/lib/next-modes/next-deploy.ts) and uses it two ways:
#   1. parseIdsFromCliOuput() extracts BUILD_ID / DEPLOYMENT_ID /
#      NEXT_SUPPORTS_IMMUTABLE_ASSETS via `.match(/… (.+)/)` — FIRST match wins.
#   2. tests read next.cliOutput to assert on build/deploy output (e.g.
#      deprecation warnings or build errors).
#
# .adapter-deploy-metadata.log holds the authoritative markers: its
# DEPLOYMENT_ID is the real one, resolved only after deploy. It MUST be emitted
# first so its values win the first-match over the post-build markers that ALSO
# appear inside .adapter-deploy.log (where DEPLOYMENT_ID is still "undefined" at
# build time, because the fixture's post-build script runs during `next build`).
if [ -f ".adapter-deploy-metadata.log" ]; then
  cat ".adapter-deploy-metadata.log"
fi

# The full build/deploy output. Surfaced so next.cliOutput contains the actual
# build-time logs (warnings, errors) that tests assert on — not just the
# metadata markers above.
if [ -f ".adapter-deploy.log" ]; then
  echo "=== .adapter-deploy.log ==="
  cat ".adapter-deploy.log"
fi

if [ -f ".adapter-server.log" ]; then
  echo "=== .adapter-server.log ==="
  cat ".adapter-server.log"
fi
