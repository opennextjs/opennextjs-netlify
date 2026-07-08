#!/usr/bin/env bash
set -euo pipefail

# Required — set by the Next.js test harness / CI environment
: "${ADAPTER_DIR:?ADAPTER_DIR must be set to the adapter repository root}"
: "${ADAPTER_TARBALL:?ADAPTER_TARBALL must point to the pre-packed adapter tarball}"
: "${NETLIFY_AUTH_TOKEN:?NETLIFY_AUTH_TOKEN must be set}"
: "${NETLIFY_SITE_ID:?NETLIFY_SITE_ID must be set}"

# Install the adapter into the temp app so netlify.toml can resolve the
# @netlify/plugin-nextjs plugin. The tarball is built and packed once in CI
# (see the "Pack adapter" workflow step) and reused across every fixture; only
# the install (which also pulls the plugin's own deps) is per-fixture.
# On failure, surface the npm output on stdout so the harness captures it (same
# rationale as the deploy command below).
if ! npm i "$ADAPTER_TARBALL" > .adapter-deploy.log 2>&1; then
  cat .adapter-deploy.log
  exit 1
fi

# Create netlify.toml pointing to the installed plugin
cat > netlify.toml <<'EOF'
[build]
  command = "npm run build"
  publish = "./.next/"

[[plugins]]
  package = "@netlify/plugin-nextjs"
EOF

# Deploy — Netlify CLI runs the build automatically before deploying. We invoke
# the netlify-cli that's already installed (and version-pinned) in the adapter's
# node_modules, rather than installing it per fixture.
# NO_COLOR=1 disables ANSI escape codes so the URL grep below is reliable.
# Deploy output is written to .adapter-deploy.log (in the per-test cwd, so no
# cross-run clash) — it is read again below AND by e2e-logs.sh, which surfaces
# it as next.cliOutput for tests that assert on build/deploy output.
#   - On success, this script's stdout must contain ONLY the deploy URL — the
#     Next.js harness reads stdout and validates it with `new URL()`
#     (next-modes/next-deploy.ts) — so deploy noise must stay out of stdout.
#   - On failure, we cat the log to stdout (below) so the harness captures it in
#     the thrown "Custom deploy script failed: <stdout> ..." error, which flows
#     into the jest failure message and the JUnit <failure> element.
# We deliberately do NOT also stream to stderr: run-tests.js buffers child output
# and prints it only for failed tests, so sending it to stderr here as well would
# duplicate the whole deploy log in the GitHub Actions failed-test output.
if ! NO_COLOR=1 "$ADAPTER_DIR/node_modules/.bin/netlify" deploy > .adapter-deploy.log 2>&1; then
  cat .adapter-deploy.log
  exit 1
fi

# Extract the permalink from the deploy output.
# Netlify CLI prints: "Draft URL: <https://xxxxx--mysite.netlify.app>"
# `|| true` so a no-match grep (under `set -o pipefail`) doesn't abort the
# script before the empty-URL check below can surface a useful error.
DEPLOY_URL=$(grep -oE 'Draft URL: <https?://[^>]+>' .adapter-deploy.log | grep -oE 'https?://[^>]+' | tail -1) || true

if [ -z "$DEPLOY_URL" ]; then
  # Surface the reason + full deploy log on stdout so the harness captures it
  # (see the note on the deploy command above).
  echo "Error: Could not extract deployment URL from deploy output"
  cat .adapter-deploy.log
  exit 1
fi

# Persist deployment metadata markers for e2e-logs.sh. These are the
# authoritative BUILD_ID / DEPLOYMENT_ID / NEXT_SUPPORTS_IMMUTABLE_ASSETS values
# (DEPLOYMENT_ID is only known here, after deploy) that the harness parses out
# of next.cliOutput.
BUILD_ID="$(cat .next/BUILD_ID 2>/dev/null || echo 'unknown')"
DEPLOYMENT_ID="$(grep -oE '/deploys/[a-f0-9]+' .adapter-deploy.log | grep -oE '[a-f0-9]+' | tail -1)" || true
{
  echo "BUILD_ID: $BUILD_ID"
  echo "DEPLOYMENT_ID: $DEPLOYMENT_ID"
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: false"
} > .adapter-deploy-metadata.log

# Only the deployment URL goes to stdout — this is what the Next.js test harness reads
echo "$DEPLOY_URL"
