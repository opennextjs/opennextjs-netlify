#!/bin/sh
# Print usage if nothing is passed
if [ -z "$1" ]; then
  echo "Usage: $0 <test-pattern>"
  exit 1
fi
# Check that the next.js directory exists
if [ ! -d "../next.js" ]; then
  echo "Error: next.js repo needs to be in ../next.js"
  exit 1
fi
export NEXT_TEST_CONTINUE_ON_ERROR=1
export NETLIFY_SITE_ID=1d5a5c76-d445-4ae5-b694-b0d3f2e2c395
export NEXT_TEST_MODE=deploy
export RUNTIME_DIR=$(pwd)
cp tests/netlify-deploy.ts ../next.js/test/lib/next-modes/netlify-deploy.ts
cd ../next.js/
git apply $RUNTIME_DIR/tests/e2e-utils.patch || git apply $RUNTIME_DIR/tests/e2e-utils-v2.patch || git apply $RUNTIME_DIR/tests/e2e-utils-v3.patch
node run-tests.js --type e2e --debug --test-pattern $1
git checkout -- test/lib/e2e-utils.ts

