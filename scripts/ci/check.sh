#!/usr/bin/env bash
# The same focused gate used by pull requests. Install with --frozen-lockfile first.
set -euo pipefail
ECMA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ECMA_ROOT/scripts/ci/versions.env"
live=false
case "${1:-}" in
  '') ;;
  --live) live=true ;;
  *) echo "usage: bash scripts/ci/check.sh [--live]" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "unexpected extra arguments" >&2; exit 2; }
: "${MIRRORS_ROOT:?set MIRRORS_ROOT to a Mirrors checkout}"
MIRRORS_ROOT="$(cd "$MIRRORS_ROOT" && pwd)"
export MIRRORS_ROOT
cd "$ECMA_ROOT"
[[ "$(node --version)" == "v$NODE_VERSION" ]] || {
  echo "CI requires Node $NODE_VERSION" >&2; exit 1;
}
[[ "$(pnpm --version)" == "$PNPM_VERSION" ]] || {
  echo "CI requires pnpm $PNPM_VERSION" >&2; exit 1;
}
actual_revision="$(git -C "$MIRRORS_ROOT" rev-parse HEAD)"
expected_revision="${MIRRORS_REF:-$MIRRORS_BASELINE}"
[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || {
  echo "MIRRORS_REF must be a full 40-character commit SHA" >&2; exit 1;
}
[[ "$actual_revision" == "$expected_revision" ]] || {
  echo "Mirrors is $actual_revision; expected $expected_revision" >&2
  echo "For a coordinated change, explicitly set MIRRORS_REF to its full commit SHA." >&2
  exit 1
}
printf 'MirrorECMA revision: %s\nMirrors revision: %s\n' \
  "$(git rev-parse HEAD)" "$actual_revision"
git status --short
git -C "$MIRRORS_ROOT" status --short
node --version
pnpm --version
(cd "$MIRRORS_ROOT" && lake --version)
if "$live"; then
  : "${APALACHE_MC:?--live requires an explicit APALACHE_MC executable}"
  [[ -x "$APALACHE_MC" ]] || { echo "APALACHE_MC is not executable" >&2; exit 1; }
  [[ "$("$APALACHE_MC" version)" == "$APALACHE_VERSION" ]] || {
    echo "live CI requires Apalache $APALACHE_VERSION" >&2; exit 1;
  }
  java -version
else
  echo "Live trace generation not requested; running compiler and offline replay gates."
fi
pnpm run check
pnpm run check:model-interface
pnpm run check:examples
pnpm run test --runInBand --no-watchman
(cd "$MIRRORS_ROOT" && lake build mirror model_interface_gen)
if "$live"; then
  pnpm run smoke:generated-counter --live
else
  pnpm run smoke:generated-counter
fi
pnpm run smoke:async-generated-counter
if "$live"; then
  pnpm run smoke:work-queue --live
else
  pnpm run smoke:work-queue
fi
