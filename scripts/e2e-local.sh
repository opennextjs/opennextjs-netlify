#!/usr/bin/env bash
set -euo pipefail

# Run the adapter e2e suite against a REAL Netlify deploy, locally — the same way
# .github/workflows/adapter-e2e.yml does, but for one test file instead of 4000.
#
# This is the triage tool. When a test in the dashboard says "test-assertion" and you
# want to know WHY, this is how you find out without pushing a commit and waiting on a
# sixteen-shard CI run.
#
#   scripts/e2e-local.sh test/e2e/app-dir/app/index.test.ts
#   scripts/e2e-local.sh app-dir/actions            # pattern, matches several files
#   scripts/e2e-local.sh <file> --build             # after editing src/ — repack first
#
# The adapter is NOT rebuilt by default. Most runs are re-runs of the same test against
# the same adapter, and rebuilding to test a change you didn't make is a wasted minute.
# The script prints the tarball's age each run, so a stale one can't quietly mislead you.
#
# The unit is a FILE, not a test. run-tests.js builds jest's argv itself and forwards
# nothing (run-tests.js:648-664), so there is no -t. That's less of a loss than it
# sounds: the deploy happens once per file (nextTestSetup), so running one test would
# cost the same deploy as running all of them. Read the trace afterwards to get at the
# one you care about.
#
# It is NOT run-local-test.sh. That script drives the OLD harness — it copies
# tests/netlify-deploy.ts into next.js and git-applies a patch to e2e-utils. The
# adapter suite doesn't work that way: next.js now calls out to the deploy scripts in
# this directory (NEXT_TEST_DEPLOY_SCRIPT_PATH and friends), so nothing needs patching
# and the only setup is getting the environment right. That's all this does.
#
# Prerequisites, once:
#   - ../next.js checked out and BUILT: `pnpm i && pnpm build` (this takes a while)
#   - chromium for playwright:          `pnpm exec playwright install chromium`
#   - `netlify login` — the CLI's own credentials are enough; NETLIFY_AUTH_TOKEN is
#     only how CI supplies a token to a machine that has never logged in.
#
# Every run deploys to a real site (draft deploys, so nothing goes live). Deploys are
# not cleaned up — e2e-cleanup.sh is deliberately a no-op — so the URL in the output
# stays reachable after the test finishes, which is usually what you want when the
# question is "what did the deployed site actually serve?".

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEXTJS_DIR="${NEXTJS_DIR:-$(cd "$ADAPTER_DIR/.." && pwd)/next.js}"

# Same site the CI workflow deploys to. Override to use your own.
NETLIFY_SITE_ID="${NETLIFY_SITE_ID:-1d5a5c76-d445-4ae5-b694-b0d3f2e2c395}"

build=0
traces=1
manifest=0
pack_next=0
patterns=()

while [ $# -gt 0 ]; do
  case "$1" in
    --build) build=1 ;;         # rebuild + repack the adapter before running
    --no-traces) traces=0 ;;    # faster; loses the playwright trace
    --manifest)  manifest=1 ;;  # apply CI's exclusions (see below)
    --pack-next) pack_next=1 ;; # test local packages/next JS too (slow)
    -h|--help) sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) patterns+=("$1") ;;
  esac
  shift
done

if [ ${#patterns[@]} -eq 0 ]; then
  echo "Usage: $0 <test-file-or-pattern>... [--build] [--no-traces] [--manifest] [--pack-next]" >&2
  exit 1
fi

if [ ! -d "$NEXTJS_DIR" ]; then
  echo "Error: next.js not found at $NEXTJS_DIR (set NEXTJS_DIR)" >&2
  exit 1
fi
if [ ! -d "$NEXTJS_DIR/packages/next/dist" ]; then
  echo "Error: next.js isn't built. In $NEXTJS_DIR: pnpm i && pnpm build" >&2
  exit 1
fi
# No NETLIFY_AUTH_TOKEN check: `netlify login` is enough. The CLI reads its own stored
# credentials, and the env var is only how CI hands it a token. If you are not logged
# in, the deploy fails with the CLI saying exactly that.

# The fixture installs the adapter as a file: dependency on this tarball, exactly as CI
# does (see e2e-deploy.sh). Packing is what makes a run test the code you just edited
# rather than the published package.
#
# Opt-in, because the common loop is "run the same test again and read the trace", and
# rebuilding the adapter each time to test a change you didn't make is a minute you
# don't get back. Pass --build after you touch src/.
if [ "$build" -eq 1 ]; then
  echo "→ Building and packing the adapter…" >&2
  (cd "$ADAPTER_DIR" && npm run build >/dev/null && mv "$(npm pack | tail -1)" adapter-package.tgz)
fi
if [ ! -f "$ADAPTER_DIR/adapter-package.tgz" ]; then
  echo "Error: no adapter-package.tgz — run once with --build" >&2
  exit 1
fi
if [ "$build" -eq 0 ]; then
  # The tarball is the adapter under test. Silently running a stale one against a source
  # tree you've since edited is the single most confusing thing this script could do, so
  # say how old it is.
  echo "→ Using adapter-package.tgz from $(date -r "$ADAPTER_DIR/adapter-package.tgz" '+%Y-%m-%d %H:%M') (--build to refresh)" >&2
fi

# next.js spawns these three directly (not via a shell), so a missing exec bit is not a
# "permission denied" you can read — it surfaces as `Custom deploy script failed:
# undefined (13)` with no output at all, 13 being EACCES. The workflow has a `chmod +x`
# step for the same reason. The bit is committed now, but a stray `git checkout` on a
# filesystem that drops it would put you right back there, so make sure.
chmod +x "$ADAPTER_DIR"/scripts/e2e-{deploy,logs,cleanup}.sh

# ---- the environment the harness reads --------------------------------------
# Mirrors the `Run deploy tests` step of adapter-e2e.yml. The three script paths are
# the whole integration: next.js shells out to them instead of knowing anything about
# Netlify.
export ADAPTER_DIR
export ADAPTER_TARBALL="$ADAPTER_DIR/adapter-package.tgz"
export NETLIFY_SITE_ID
export NEXT_TEST_MODE=deploy
export NEXT_TEST_DEPLOY_SCRIPT_PATH="$ADAPTER_DIR/scripts/e2e-deploy.sh"
export NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="$ADAPTER_DIR/scripts/e2e-logs.sh"
export NEXT_TEST_CLEANUP_SCRIPT_PATH="$ADAPTER_DIR/scripts/e2e-cleanup.sh"
export IS_TURBOPACK_TEST=1
export NEXT_E2E_TEST_TIMEOUT=240000
export NEXT_TELEMETRY_DISABLED=1
export NODE_OPTIONS="--import $ADAPTER_DIR/tools/fetch-retry.mjs"
export NEXT_TEST_SKIP_CLEANUP=1
export ADAPTER_DEBUG_LOGS=1

# ---- making the run test YOUR next.js checkout ------------------------------
# By default it does NOT. Deploy mode calls createTestDir({skipInstall: true})
# (next-modes/next-deploy.ts:239), and that path writes a plain version string
# into the fixture's package.json (`next: NEXT_TEST_VERSION || <local version>`,
# next-modes/base.ts:304). A bare version resolves from the public npm registry.
#
# Upstream gets away with this because their CI points npm at Vercel's
# preview-builds mirror, so the version resolves to the PR's own artifact
# (writeMirrorNpmrcIfNecessary, next-deploy.ts:506). It needs
# PREVIEW_BUILDS_READ_TOKEN + NEXT_TEST_PREVIEW_BUILDS_BASE_URL, which are
# Vercel-internal. Without them the harness logs "Skipping .npmrc write" and
# falls back to public npm — so the suite tests PUBLISHED next plus your
# adapter, and nothing from $NEXTJS_DIR except the test files jest reads
# directly. That failure is silent, which is what makes it worth this comment.
#
# NEXT_TEST_NATIVE_DIR is the supported override for the Rust half: next loads
# `next-swc.<triple>.node` straight out of this directory instead of the
# @next/swc npm package (build/swc/index.ts:1552 — "Use the binary directly to
# skip `pnpm pack` for testing as it's slow because of the large native
# binary"). That covers crates/ and turbopack/crates/, and costs nothing since
# the binary is already built.
if ls "$NEXTJS_DIR/packages/next-swc/native/"*.node >/dev/null 2>&1; then
  export NEXT_TEST_NATIVE_DIR="$NEXTJS_DIR/packages/next-swc/native"
  echo "→ next-swc: local build ($(cd "$NEXTJS_DIR" && git rev-parse --short HEAD))" >&2
else
  echo "→ WARNING: no local next-swc binary — Rust changes in $NEXTJS_DIR will NOT be tested." >&2
  echo "   Build it: (cd $NEXTJS_DIR && pnpm --filter @next/swc run build-native-release)" >&2
fi

# The JS half. Opt-in because packing next is slow and most changes under
# investigation are Rust or adapter-side; without it, packages/next/src edits in
# your checkout are NOT exercised.
#
# @next/env is packed too and pinned via NEXT_ENV_TARBALL (read by
# e2e-deploy.sh): next's package.json pins an exact, non-optional dependency on
# @next/env at this same checkout's version, and a dev checkout tracking canary
# is routinely ahead of what's actually published — installing next_tgz alone
# would then fail resolving @next/env from the registry.
if [ "$pack_next" -eq 1 ]; then
  echo "→ Packing next from $NEXTJS_DIR (this takes a minute)…" >&2
  next_tgz="$(cd "$NEXTJS_DIR/packages/next" && pnpm pack --pack-destination "$TMPDIR" 2>/dev/null | tail -1)"
  if [ ! -f "$next_tgz" ]; then
    echo "Error: pnpm pack did not produce a tarball (got '$next_tgz')" >&2
    exit 1
  fi
  export NEXT_TEST_VERSION="file:$next_tgz"
  echo "→ next: $NEXT_TEST_VERSION" >&2

  next_env_tgz="$(cd "$NEXTJS_DIR/packages/next-env" && pnpm pack --pack-destination "$TMPDIR" 2>/dev/null | tail -1)"
  if [ ! -f "$next_env_tgz" ]; then
    echo "Error: pnpm pack did not produce a tarball for next-env (got '$next_env_tgz')" >&2
    exit 1
  fi
  export NEXT_ENV_TARBALL="$next_env_tgz"
  echo "→ @next/env: file:$NEXT_ENV_TARBALL" >&2
fi

# CI's manifest (test/deploy-tests-manifest.json) EXCLUDES individual cases it has
# already recorded as failing or flaky. That's right for a green-vs-red signal and
# exactly wrong for triage: the case you're investigating is quite likely one of the
# excluded ones, and it would silently not run. Off unless you ask for it.
if [ "$manifest" -eq 1 ]; then
  export NEXT_EXTERNAL_TESTS_FILTERS=test/deploy-tests-manifest.json
fi

# Traces. TRACE_PLAYWRIGHT makes the harness record a full playwright trace per browser
# context (screenshots, DOM snapshots, network, console) and copy next's own build trace
# out of the fixture. run-tests.js already sets it for the jest child unless you pass
# --local (run-tests.js:681) — we set it here too, explicitly, because relying on the
# default would make --no-traces a no-op.
#
# PRESERVE_TRACES_OUTPUT is the one that actually matters. Without it, run-tests.js
# DELETES test/traces/<file> the moment the file finishes, and the condition
#   (process.env.CI && failed) || process.env.PRESERVE_TRACES_OUTPUT
# means that locally — where CI is unset — the traces are deleted EVEN WHEN THE TEST
# FAILS. Which is exactly when you wanted them.
if [ "$traces" -eq 1 ]; then
  export TRACE_PLAYWRIGHT=1
  export PRESERVE_TRACES_OUTPUT=1
fi

# NEXT_TEST_JOB is deliberately NOT set: it makes run-tests.js buffer child output and
# print it only for failures. Locally you want to watch the deploy happen.

cd "$NEXTJS_DIR"
echo "→ Running ${patterns[*]} (deploy mode, site $NETLIFY_SITE_ID)" >&2

# --retries 0 (default is 2, run-tests.js:187). Two reasons, both about triage:
#
# A retry re-deploys the whole fixture, so a failing file costs three deploys and
# three timeouts before it reports — and a test that fails once and passes on retry
# is reported as PASSED, which is precisely the flake you were trying to catch.
#
# More urgently: before each retry run-tests.js runs `git clean -fdx` AND
# `git checkout` on the test's directory (run-tests.js:886-897) to reset fixture
# state. That is destructive to UNCOMMITTED work in the next.js checkout — edit a
# test file, have it fail, and the retry silently reverts your edit. Nothing warns
# you; the run just starts passing again against the old code.
status=0
node run-tests.js --type e2e --debug --retries 0 --test-pattern "${patterns[*]}" || status=$?

if [ "$traces" -eq 1 ] && [ -d "$NEXTJS_DIR/test/traces" ]; then
  echo >&2
  echo "→ Traces in $NEXTJS_DIR/test/traces:" >&2
  find "$NEXTJS_DIR/test/traces" -name '*.zip' -newermt '-1 hour' 2>/dev/null | while read -r z; do
    echo "    npx playwright show-trace $z" >&2
  done
fi

exit $status
