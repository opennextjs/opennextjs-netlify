#!/usr/bin/env bash
set -euo pipefail

# Required — set by the Next.js test harness / CI environment
: "${ADAPTER_DIR:?ADAPTER_DIR must be set to the adapter repository root}"
: "${ADAPTER_TARBALL:?ADAPTER_TARBALL must point to the pre-packed adapter tarball}"
: "${NETLIFY_AUTH_TOKEN:?NETLIFY_AUTH_TOKEN must be set}"
: "${NETLIFY_SITE_ID:?NETLIFY_SITE_ID must be set}"

# Every command below appends its output to this single log file, so on any
# failure we can cat it and see the full history (install + build + deploy) at
# once. It's also what e2e-logs.sh replays as next.cliOutput. cwd is a fresh
# per-fixture temp dir, but initialize it empty to be defensive.
: > .adapter-deploy.log

# In deploy mode the Next.js harness creates the temp app with `skipInstall`
# (test/lib/next-modes/next-deploy.ts -> createTestDir({ skipInstall: true })):
# it writes package.json + fixture files + an .npmrc pointing at the
# preview-builds npm mirror, but installs nothing. `netlify deploy` runs the
# build but does NOT install dependencies either, so the deploy script is what
# has to populate node_modules.
#
# Declare the adapter as a file: dependency on the pre-packed adapter tarball,
# named @netlify/plugin-nextjs (what netlify.toml references below), so the
# install below picks it up.
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['@netlify/plugin-nextjs'] = 'file:${ADAPTER_TARBALL}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
" >&2

# Which package manager installs the fixture is not ours to pick. The harness
# always writes a `packageManager` field into the temp app's package.json
# (test/lib/next-modes/base.ts): the next.js repo's own pnpm by default, but a
# test may override it — handle-non-hoisted-swc-helpers and filesystem-cache ask
# for npm, yarn-pnp asks for yarn, because the test is *about* that package
# manager's node_modules layout. CI runs with corepack enabled, and corepack
# refuses to run a package manager the project didn't ask for:
#   "This project is configured to use npm because <dir>/package.json has a
#    "packageManager" field"
# So dispatch on the field rather than hardcoding one.
#
# Each install needs the same two concessions, spelled differently per manager:
#   (a) tolerate peer-dependency conflicts. Fixtures pin next/react versions that
#       don't satisfy every peer range in the tree, and the adapter arrives as a
#       file: tarball whose own peers won't line up either. This must warn, not
#       fail.
#   (b) don't demand a lockfile. The temp app is generated fresh and has none, so
#       any "must match the lockfile" mode aborts immediately.
PACKAGE_MANAGER="$(node -p "(require('./package.json').packageManager || 'pnpm').split('@')[0]")"
case "$PACKAGE_MANAGER" in
  # pnpm fails the install on a peer conflict, and --frozen-lockfile is its
  # default when CI=true — so both concessions have to be made explicitly.
  pnpm) INSTALL=(pnpm install --strict-peer-dependencies=false --no-frozen-lockfile) ;;
  # npm errors with ERESOLVE on a peer conflict; --legacy-peer-deps downgrades
  # that to a warning. `npm install` (unlike `npm ci`) already writes the
  # lockfile it lacks, so there's nothing to relax for (b).
  npm) INSTALL=(npm install --legacy-peer-deps) ;;
  # yarn only ever warns about peers, so (a) is free. For (b): yarn 1 is
  # non-immutable by default, while yarn 2+ turns immutable installs ON when
  # CI=true and then dies on the missing lockfile. Setting that via the env var
  # rather than --no-immutable covers yarn 2+ without yarn 1 (which is what
  # yarn-pnp pins) choking on a flag it has never heard of.
  yarn) INSTALL=(env YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install) ;;
  *)
    echo "Unsupported packageManager '$PACKAGE_MANAGER' in the fixture's package.json"
    exit 1
    ;;
esac

# Install into the temp app: `next` (resolved from the preview-builds mirror via
# the harness-written .npmrc), react, the fixture's own deps, and the file:
# adapter. This is the ONLY thing that populates node_modules.
# On failure, cat the full log to stdout so the harness captures it (same
# rationale as the deploy command below).
if ! "${INSTALL[@]}" >> .adapter-deploy.log 2>&1; then
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

# Deploy — Netlify CLI runs the build (`npm run build`) automatically before
# deploying. Dependencies are already installed by `npm install` above. We invoke
# the netlify-cli that's already installed (and version-pinned) in the adapter's
# node_modules, rather than installing it per fixture.
# NO_COLOR=1 disables ANSI escape codes so the URL grep below is reliable.
# Output is appended to .adapter-deploy.log (the single log file), which is read
# again below AND replayed by e2e-logs.sh as next.cliOutput.
#   - On success, this script's stdout must contain ONLY the deploy URL — the
#     Next.js harness reads stdout and validates it with `new URL()`
#     (next-modes/next-deploy.ts) — so command output must stay out of stdout.
#   - On failure, we cat the full log to stdout (below) so the harness captures it
#     in the thrown "Custom deploy script failed: <stdout> ..." error, which flows
#     into the jest failure message and the JUnit <failure> element.
# We deliberately do NOT also stream to stderr: run-tests.js buffers child output
# and prints it only for failed tests, so sending it to stderr here as well would
# duplicate the whole log in the GitHub Actions failed-test output.
if ! NO_COLOR=1 NETLIFY_NEXT_SKEW_PROTECTION=1 "$ADAPTER_DIR/node_modules/.bin/netlify" deploy >> .adapter-deploy.log 2>&1; then
  cat .adapter-deploy.log
  exit 1
fi

# Extract the permalink from the deploy output.
# Netlify CLI prints: "Draft URL: <https://xxxxx--mysite.netlify.app>"
# `|| true` so a no-match grep (under `set -o pipefail`) doesn't abort the
# script before the empty-URL check below can surface a useful error.
DEPLOY_URL=$(grep -oE 'Draft URL: <https?://[^>]+>' .adapter-deploy.log | grep -oE 'https?://[^>]+' | tail -1) || true

if [ -z "$DEPLOY_URL" ]; then
  # Surface the reason + full log on stdout so the harness captures it
  # (see the note on the deploy command above).
  echo "Error: Could not extract deployment URL from deploy output"
  cat .adapter-deploy.log
  exit 1
fi

# No metadata markers are written here any more.
#
# We used to emit BUILD_ID / DEPLOYMENT_ID / NEXT_SUPPORTS_IMMUTABLE_ASSETS into
# .adapter-deploy-metadata.log, which e2e-logs.sh printed FIRST so it won the harness's
# first-match parse. All three are redundant — the fixture's post-build script already
# prints them from inside the build (the harness appends `&& pnpm post-build` to every
# fixture's build script in deploy mode) — and the DEPLOYMENT_ID we supplied was
# actively WRONG: it was the Netlify deploy id scraped from the deploy URL, whereas
# Next.js means the skew protection token by "deployment id" — the value inlined into
# the bundle, which skew tests then send back as ?dpl= / x-deployment-id / __vdpl.
#
# post-build echoes process.env.NEXT_DEPLOYMENT_ID, which our own onPreBuild sets from
# NETLIFY_SKEW_PROTECTION_TOKEN (src/build/skew-protection.ts). That token only exists
# inside the Netlify build container — which is precisely why the fixture, running in
# there, is the right thing to report it, and this script, running out here, is not.
#
# Only the deployment URL goes to stdout — this is what the Next.js test harness reads
echo "$DEPLOY_URL"
