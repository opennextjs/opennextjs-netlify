#!/usr/bin/env bash
set -euo pipefail

# Install netlify-cli into the temp app so it is available without a global install
npm i -D netlify-cli >&2

# Symlink the adapter's built dist into the temp app so netlify.toml can reference it
# with a relative path (netlify.toml only supports relative paths for local plugins)
ln -sf "$ADAPTER_DIR/dist/" ./next-runtime

# Create netlify.toml pointing to the local plugin build
cat > netlify.toml <<'EOF'
[build]
  command = "npm run build"
  publish = "./.next/"

[[plugins]]
  package = "./next-runtime/"
EOF

# Deploy — Netlify CLI runs the build automatically before deploying.
# NO_COLOR=1 disables ANSI escape codes so the URL grep below is reliable.
# All output goes to the log file and to stderr; nothing reaches stdout.
NO_COLOR=1 npx netlify deploy --prod 2>&1 | tee .adapter-deploy.log >&2

# Extract the production site URL from the deploy output.
# Netlify CLI prints: "Production URL: <https://mysite.netlify.app>"
DEPLOY_URL=$(grep -oE 'Production URL: <https?://[^>]+>' .adapter-deploy.log | grep -oE 'https?://[^>]+' | tail -1)

if [ -z "$DEPLOY_URL" ]; then
  echo "Error: Could not extract deployment URL from deploy output" >&2
  exit 1
fi

# Persist metadata for e2e-logs.sh
BUILD_ID="$(cat .next/BUILD_ID 2>/dev/null || echo 'unknown')"
{
  echo "BUILD_ID: $BUILD_ID"
  echo "DEPLOYMENT_ID: $DEPLOY_URL"
  echo "IMMUTABLE_ASSET_TOKEN: undefined"
} > .adapter-build.log

# Only the deployment URL goes to stdout — this is what the Next.js test harness reads
echo "$DEPLOY_URL"
