#!/usr/bin/env bash
# The whole-repo definition of done, run before any push: every project's typecheck, lint,
# format check and test suite, ending with the Playwright e2e suite against a production
# build. The e2e step is not optional - the first CI run of this repo caught a real crash
# (a malformed list body taking down the incidents route) that unit tests and local vitest
# never exercised, because only e2e runs the built app.
#
# Run the suites SEQUENTIALLY, never in parallel: parallel runs starve the LocalStack
# containers and time their tests out. If a *.integration.test.ts / *.localstack.test.ts
# file still fails on a container timeout (read ECONNRESET / "waiting for container ports"),
# re-run that file alone before concluding anything:
#   cd backend && npx vitest run <file>
#
# Usage: scripts/verify-all.sh   (runs every step even after a failure; exits non-zero if any failed)
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
run() { # run <dir> <label> <cmd...>
  local dir="$1" label="$2"; shift 2
  echo "== [$dir] $label"
  (cd "$root/$dir" && "$@") || { echo "** FAILED: [$dir] $label"; fail=1; }
}

run backend        typecheck npm run typecheck
run backend        lint      npm run lint
run backend        format    npm run format
run backend        tests     npx vitest run
run infrastructure typecheck npm run typecheck
run infrastructure lint      npm run lint
run infrastructure format    npm run format
run infrastructure tests     npx vitest run
run ui             typecheck npm run typecheck
run ui             lint      npm run lint
run ui             format    npm run format
run ui/apps/web    tests     npx vitest run
run ui/apps/mobile tests     npx jest
run ui/apps/web    e2e       npm run test:e2e

if [ "$fail" -ne 0 ]; then
  echo "verify-all: FAILED (see ** lines above; re-run LocalStack timeouts alone first)"
  exit 1
fi
echo "verify-all: all green"
