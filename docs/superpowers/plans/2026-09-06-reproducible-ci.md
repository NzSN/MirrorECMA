# Reproducible CI implementation plan

Design: [reproducible client and interop CI](../specs/2026-09-06-reproducible-ci-design.md).

Status: implemented and locally verified on 2026-09-06. Hosted/full-matrix limits remain explicit below.

Owner: `reproducible_ci` subagent. Coordinator owns package.json, workspace policy, and top-level onboarding; native-build worker owns the native regression gate. Existing tutorial integration is preserved.

## Tasks

1. [x] Inspect current lockfiles, tools, workflow setup, external-client paths and release metadata. Record published baseline revisions and official Apalache checksum.
2. [x] Add per-repository version configuration and checksum-verifying Apalache installers. Pin Java/Node/pnpm and published source/action revisions; preserve the current synchronous compiler baseline and provide full-SHA coordinated overrides.
3. [x] Add MirrorECMA push/PR/manual workflow and local `scripts/ci/check.sh`: frozen installation, typechecks, Jest, server/compiler build, Counter freshness and actual executable acceptance. Keep real Apalache opt-in with fatal missing prerequisites.
4. [x] Repair the broad Mirrors workflow: pnpm lockfile, explicit Haskell/Java setup and correct executable target, pinned client sources, locked Cargo, Hackage index-state, native incremental build job, additional trigger paths.
5. [x] Make matrix paths portable and diagnostics explicit. Export live Apalache to all legs, log revisions/tools, require full-matrix prerequisites, preserve Counter acceptance, and assert Haskell TLS positive/negative outcomes.
6. [x] Verify exact entry points, installer, workflow syntax and relevant integration behavior. Record any environment or hosted-only limitation below and hand off package metadata to the coordinator.

## Validation evidence

- Clean temporary checkout install (`pnpm install --frozen-lockfile --offline`, 301 locked packages plus real prepare/tsc): passed with pnpm 11.22.0 after allowing access to its local SQLite package store. Existing-checkout frozen install passed too. The obsolete package.json policy warning was passed to the coordinator for cleanup; pnpm-workspace.yaml already owns the policy.
- YAML parser and `bash -n` for every changed shell entry point: passed.
- Official checksum-verified actionlint 1.7.11: both workflows passed.
- `scripts/ci/install-apalache.sh /tmp/mirrorecma-ci-apalache-0.61.0`: downloaded the pinned archive, verified its digest, and reported 0.61.0 successfully.
- Exact focused gate `MIRRORS_ROOT=/home/nzsn/Repos/Mirrors APALACHE_MC=/tmp/mirrorecma-ci-apalache-0.61.0/bin/apalache-mc bash scripts/ci/check.sh --live`: passed after dependent implementation changes settled. Three typechecks, 13 Jest suites/346 tests, server/compiler build, compiler freshness/preflight, stale-output rejection, offline Counter pass plus genuine count mismatch, and live fresh traces all passed. Offline coverage was Initialize=1/Tick=2; live coverage Initialize=2/Tick=8.
- Portable Haskell mTLS helper: real `VALID` positive replay, fingerprint-mismatch rejection, and rogue-client `UnknownCa` rejection passed against the existing Haskell binary and downloaded pinned Apalache. The matrix fixture-copy setup was performed before calling the helper.
- The first concurrent Jest run had a stale `opaqueItf` rejection assertion and sandbox `listen EPERM`; after the dynamic owner updated the intended behavior and loopback was permitted, the exact integrated command above passed. These initial results were not treated as CI regressions.
- Mutable compiler ref `MIRRORS_REF=main` and requested `--live` without APALACHE_MC both failed before workload, with the intended diagnostics.
- Native gate owner separately reported the exact native command passed all six mutation/no-op cases.
- Full external-client matrix and GitHub-hosted workflows have not been executed by this task. Their tool/source setup is statically checked; local focused evidence is not a hosted green result.

## Coordinator handoff

Coordinator integrated `packageManager: pnpm@11.22.0`, removed the obsolete package.json pnpm policy field, and exposed `"ci": "bash scripts/ci/check.sh"`. The lockfile remains frozen. Link the local check and matching-revision policy from top-level development instructions. The coordinator can extend the same focused entry point with the work-queue gate when that independent example is ready; asynchronous compiler regeneration belongs to a matching current Mirrors checkout rather than the published synchronous baseline.

For a paired local worktree:

```bash
pnpm install --frozen-lockfile
MIRRORS_ROOT=../Mirrors bash scripts/ci/check.sh
# When deliberately pairing with a newer committed server:
MIRRORS_ROOT=../Mirrors MIRRORS_REF=<full-40-character-commit> bash scripts/ci/check.sh
# Explicit live tier, after installing the pinned release:
MIRRORS_ROOT=../Mirrors APALACHE_MC=/path/to/apalache/bin/apalache-mc \
  bash scripts/ci/check.sh --live
```

## Final coordinated integration

The coordinator extended the same focused entry point with async generated
Counter and work-queue acceptance. Its final permitted `scripts/ci/check.sh
--live` run passed all three TypeScript checks, 16 Jest suites/385 tests, Counter
offline/live replay, async filesystem Counter positive and typed negative cases,
and queue artifact/offline/live/cleanup cases. The earlier 346-test run above
records this task's initial integrated baseline; 385 is the final coordinated
result. The coordinator also reported full live `lake test` passed, including
the async emitter Python gate and native transport/registry runtime coverage.
Hosted workflows and the external C++/Rust/Haskell full matrix remain separate
from these completed gates.
