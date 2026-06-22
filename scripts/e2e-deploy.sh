#!/usr/bin/env bash
set -euo pipefail

# Required — set by the Next.js test harness
: "${ADAPTER_DIR:?ADAPTER_DIR must be set to the adapter repository root}"
# Required — provided via CI environment
: "${NETLIFY_AUTH_TOKEN:?NETLIFY_AUTH_TOKEN must be set}"
: "${NETLIFY_SITE_ID:?NETLIFY_SITE_ID must be set}"

# Install netlify-cli into the temp app so it is available without a global install
npm i -D netlify-cli >&2

# Pack the adapter and install it into the temp app
TARBALL="$(cd "$ADAPTER_DIR" && npm pack 2>/dev/null | tail -1)"
npm i "$ADAPTER_DIR/$TARBALL" >&2

# Create netlify.toml pointing to the installed plugin
cat > netlify.toml <<'EOF'
[build]
  command = "npm run build"
  publish = "./.next/"

[[plugins]]
  package = "@netlify/plugin-nextjs"
EOF

# Deploy — Netlify CLI runs the build automatically before deploying.
# NO_COLOR=1 disables ANSI escape codes so the URL grep below is reliable.
# All output goes to the log file and to stderr; nothing reaches stdout.
NO_COLOR=1 npx netlify deploy 2>&1 | tee .adapter-deploy.log >&2

# Extract the permalink from the deploy output.
# Netlify CLI prints: "Draft URL: <https://xxxxx--mysite.netlify.app>"
DEPLOY_URL=$(grep -oE 'Draft URL: <https?://[^>]+>' .adapter-deploy.log | grep -oE 'https?://[^>]+' | tail -1)

if [ -z "$DEPLOY_URL" ]; then
  echo "Error: Could not extract deployment URL from deploy output" >&2
  exit 1
fi

# Persist metadata for e2e-logs.sh
BUILD_ID="$(cat .next/BUILD_ID 2>/dev/null || echo 'unknown')"
DEPLOYMENT_ID="$(grep -oE '/deploys/[a-f0-9]+' .adapter-deploy.log | grep -oE '[a-f0-9]+' | tail -1)"
{
  echo "BUILD_ID: $BUILD_ID"
  echo "DEPLOYMENT_ID: $DEPLOYMENT_ID"
  echo "supportsImmutableAssets: false"
} > .adapter-build.log

# Only the deployment URL goes to stdout — this is what the Next.js test harness reads
echo "$DEPLOY_URL"
