#!/usr/bin/env bash
set -euo pipefail

ecma_root="${MIRRORECMA_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
gate_root="${MIRRORGATE_ROOT:?MIRRORGATE_ROOT must name the pinned MirrorGate checkout}"
mirrors_root="${MIRRORS_ROOT:?MIRRORS_ROOT must name the pinned Mirrors checkout}"
mirrorcpp_root="${MIRRORCPP_ROOT:?MIRRORCPP_ROOT must name the pinned MirrorCPP checkout}"

expected_ecma="${MIRRORECMA_EXPECTED_REV:?MIRRORECMA_EXPECTED_REV must be a full commit SHA}"
expected_gate="${MIRRORGATE_EXPECTED_REV:?MIRRORGATE_EXPECTED_REV must be a full commit SHA}"
expected_mirrors="${MIRRORS_EXPECTED_REV:?MIRRORS_EXPECTED_REV must be a full commit SHA}"
expected_cpp="${MIRRORCPP_EXPECTED_REV:?MIRRORCPP_EXPECTED_REV must be a full commit SHA}"

: "${APALACHE_MC:?APALACHE_MC must name the pinned apalache-mc executable}"
: "${MIRRORGATE_NODE_RUNTIME_ROOT:?MIRRORGATE_NODE_RUNTIME_ROOT must name the pinned Node runtime tree}"
: "${MIRRORCPP_DEPENDENCY_CACHE:?MIRRORCPP_DEPENDENCY_CACHE must name the prepared C++ dependency cache}"

full_sha='^[0-9a-f]{40}$'
for expected in "$expected_ecma" "$expected_gate" "$expected_mirrors" "$expected_cpp"; do
  [[ "$expected" =~ $full_sha ]] || { echo "expected revisions must be full lowercase commit SHAs" >&2; exit 1; }
done

verify_checkout() {
  local label="$1" root="$2" expected="$3" actual
  [[ -d "$root/.git" ]] || { echo "$label checkout is missing: $root" >&2; exit 1; }
  actual="$(git -C "$root" rev-parse HEAD)"
  [[ "$actual" == "$expected" ]] || {
    echo "$label revision mismatch: expected $expected, got $actual" >&2
    exit 1
  }
  [[ -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)" ]] || {
    echo "$label checkout must be clean before required acceptance: $root" >&2
    exit 1
  }
}

verify_checkout MirrorECMA "$ecma_root" "$expected_ecma"
verify_checkout MirrorGate "$gate_root" "$expected_gate"
verify_checkout Mirrors "$mirrors_root" "$expected_mirrors"
verify_checkout MirrorCPP "$mirrorcpp_root" "$expected_cpp"

[[ -x "$APALACHE_MC" ]] || { echo "Apalache executable is missing: $APALACHE_MC" >&2; exit 1; }
[[ -x "$MIRRORGATE_NODE_RUNTIME_ROOT/bin/node" ]] || {
  echo "pinned Node runtime tree is missing bin/node: $MIRRORGATE_NODE_RUNTIME_ROOT" >&2
  exit 1
}
[[ -d "$MIRRORCPP_DEPENDENCY_CACHE/nlohmann_json-src" ]] || {
  echo "MirrorCPP nlohmann_json dependency cache is missing: $MIRRORCPP_DEPENDENCY_CACHE" >&2
  exit 1
}
command -v bwrap >/dev/null
command -v lake >/dev/null
command -v node >/dev/null
command -v python3 >/dev/null
command -v rustc >/dev/null
command -v cmake >/dev/null
command -v c++ >/dev/null

[[ -x "$ecma_root/node_modules/.bin/tsc" ]] || {
  echo "MirrorECMA locked dependencies are not installed: $ecma_root/node_modules" >&2
  exit 1
}

cd "$ecma_root"
pnpm run check:sandbox

cd "$mirrors_root"
lake build mirror model_interface_gen

evidence="${MIRRORGATE_CONTROL_EVIDENCE:-${RUNNER_TEMP:-/tmp}/mirrorgate-control-v1-${GITHUB_RUN_ID:-local}.jsonl}"
export MIRRORECMA_ROOT="$ecma_root"
export MIRRORGATE_ROOT="$gate_root"
export MIRRORS_ROOT="$mirrors_root"
export MIRRORCPP_ROOT="$mirrorcpp_root"
export MIRROR_BIN="$mirrors_root/.lake/build/bin/mirror"
export MIRRORGATE_CONTROL_EVIDENCE="$evidence"

cd "$gate_root"
bash conformance/control-v1/run

[[ -s "$evidence" ]] || { echo "shared acceptance emitted no evidence: $evidence" >&2; exit 1; }
[[ -s "$evidence.manifest.json" ]] || {
  echo "shared acceptance emitted no reproducibility manifest: $evidence.manifest.json" >&2
  exit 1
}
echo "shared orchestration evidence: $evidence"
echo "shared orchestration reproducibility manifest: $evidence.manifest.json"
