# Design: ModelMirrors as Bazel Module Dependency

**Date:** 2026-06-04
**Status:** approved

## Context

MirrorECMA currently locates the ModelMirrors binary via the `MIRROR_BIN` environment variable. The smoke test auto-skips if the variable is unset. This makes `bazel test` impractical — the binary must be built and located manually.

ModelMirrors is itself a Bazel module (`name = "modelmirros"`, version `0.1.0.0`) with an executable target `//app:ModelMirrors`. By declaring it as a bzlmod dependency, MirrorECMA can run `bazel test //:smoke` fully hermetically — Bazel builds the Haskell binary from source, passes its path to the test, and no env vars are needed.

## Approach

Use `git_override` in MODULE.bazel to pull ModelMirrors directly from GitHub. Add an `sh_test` target that depends on `@modelmirros//app:ModelMirrors` and runs the existing jest smoke test with the binary path injected via `$(rootpath)`.

## Changes

### 1. MODULE.bazel

Add:

```python
bazel_dep(name = "modelmirros", version = "0.1.0.0")
git_override(
    module_name = "modelmirros",
    remote = "https://github.com/NzSN/ModelMirrors",
    commit = "c6647b25f053326671f56cfde535cd35379b9dca",
)
```

ModelMirrors' transitive overrides (`rules_haskell`, `rules_sh`) propagate automatically. No need to duplicate them.

### 2. BUILD.bazel

Add an `sh_test` target alongside the existing `genrule`:

```python
sh_test(
    name = "smoke",
    srcs = ["scripts/smoke_bazel"],
    args = ["$(rootpath @modelmirros//app:ModelMirros)"],
    data = [
        "@modelmirros//app:ModelMirros",
        "test/smoke.test.ts",
        "specs/Counter.tla",
        "package.json",
    ],
    tags = ["local", "no-sandbox"],
    env = {"NODE_OPTIONS": "--experimental-vm-modules"},
)
```

- `local` + `no-sandbox`: same as the existing `genrule`, so `node_modules/` is available.
- `$(rootpath ...)` resolves to the runfiles path of the ModelMirrors binary.
- `data` includes the smoke test, spec file, and package.json (for jest config lookup).

### 3. scripts/smoke_bazel (new)

A thin wrapper that receives the binary path as `$1`, sets `MIRROR_BIN`, and runs jest:

```bash
#!/usr/bin/env bash
set -euo pipefail
export MIRROR_BIN="$1"
npx jest test/smoke.test.ts
```

### 4. Backward compatibility

- `scripts/smoke` (manual smoke runner): unchanged.
- `npm run smoke -- <path>`: unchanged.
- `test/smoke.test.ts`: unchanged; still reads `MIRROR_BIN`.

## Dependency footprint

Adding `modelmirros` as a Bazel dep pulls in its transitive dependencies: `rules_haskell`, `rules_sh`, GHC 9.10.1 bindist, and a Stackage snapshot. This is approximately 500MB+ on first build. The cost is one-time per machine; subsequent builds are incremental.

## What stays the same

- `src/transport.ts` — `spawnMirror(binPath)` API unchanged.
- `src/client.ts` — `runClient(binPath, ...)` API unchanged.
- `test/smoke.test.ts` — still reads `MIRROR_BIN` env var.
- Existing `genrule` for TypeScript compilation — unchanged.

## Result

```sh
bazel test //:smoke          # hermetic: builds ModelMirrors, runs smoke test
npm run smoke -- <path>      # manual: still works with pre-built binary
bazel build //:lib            # library build: unchanged
```
