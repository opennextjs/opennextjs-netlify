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
patterns=()

while [ $# -gt 0 ]; do
  case "$1" in
    --build) build=1 ;;         # rebuild + repack the adapter before running
    --no-traces) traces=0 ;;    # faster; loses the playwright trace
    --manifest)  manifest=1 ;;  # apply CI's exclusions (see below)
    -h|--help) sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) patterns+=("$1") ;;
  esac
  shift
done

if [ ${#patterns[@]} -eq 0 ]; then
  echo "Usage: $0 <test-file-or-pattern>... [--build] [--no-traces] [--manifest]" >&2
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

status=0
node run-tests.js --type e2e --debug --test-pattern "${patterns[*]}" || status=$?

if [ "$traces" -eq 1 ] && [ -d "$NEXTJS_DIR/test/traces" ]; then
  echo >&2
  echo "→ Traces in $NEXTJS_DIR/test/traces:" >&2
  find "$NEXTJS_DIR/test/traces" -name '*.zip' -newermt '-1 hour' 2>/dev/null | while read -r z; do
    echo "    npx playwright show-trace $z" >&2
  done
fi

exit $status
