# Reproducible client and interop CI

Status: implemented; local validation is recorded in the linked plan. GitHub-hosted execution and the full external-client matrix remain separate validation obligations.

## Problem and result

Mirrors interop installs MirrorECMA with `npm ci` and a nonexistent `package-lock.json`, follows moving client branches and the latest Apalache release, and omits explicit Java/Haskell setup. MirrorECMA has no PR workflow for its generated Counter onboarding contract. Clean checkouts can therefore fail before exercising application behavior, or change behavior when unrelated dependencies move.

The client gains a focused push/PR gate that installs `pnpm-lock.yaml` with the pinned pnpm release, typechecks all supported configurations, runs Jest, builds a published Mirrors compiler, and checks the tutorial artifacts and passing/faulty executables. The broader Mirrors workflow retains its stdio/TCP/mTLS matrix and gains explicit client/tool identities and native incremental-build coverage.

## Gates and ownership

| Gate | Trigger | Dependencies | Required evidence |
| --- | --- | --- | --- |
| MirrorECMA focused | Every push and pull request | Node, pnpm, Lean, C compiler, OpenSSL headers | Three typechecks; Jest; compiler freshness/preflight; stale-output negative; actual correct/faulty Counter replay |
| MirrorECMA live | Explicit workflow dispatch with `live: true` | Focused prerequisites plus pinned Java and Apalache | Focused evidence plus fresh generated traces through the same adapter |
| Mirrors native build | Relevant PR or manual dispatch | Lean, Python 3.11+, C compiler, OpenSSL | `bash tools/check-native-rebuild.sh` demonstrates invalidation and no-op stability in a temporary copy |
| Mirrors full interop | Relevant PR or manual dispatch | All clients, Rust, GHC/Cabal, Java, Apalache, C++/CMake | Existing real stdio/TCP/mTLS matrix; missing live prerequisites fail before build |

`MirrorECMA/scripts/ci/check.sh` is the local and CI entry point. It does not install tools, rewrite artifacts, or fetch source. Installation remains the explicit `pnpm install --frozen-lockfile` step. `--live` requires an explicit executable `APALACHE_MC` and checks its version; without the flag the supplied-trace tier still proves it does not invoke Apalache.

The existing Haskell mTLS helper becomes checkout-relative and consumes `HS_BIN`/`LEAN_BIN`. A passing positive case and specific nonzero TLS rejection diagnostics are required; timeout, missing executable, and arbitrary failure no longer masquerade as a passing negative. `run.sh` requires an already built Haskell executable so it can consume that checkout without changing Cabal caches.

## Versions, checksums, and pairing

Each repository carries a small reviewed `versions.env`. Node 24.15.0, pnpm 11.22.0, Java 25.0.4+7, and Apalache 0.61.0 match the locally inspected version family. The installer downloads the versioned Apalache archive, compares its SHA-256 with the release asset digest, and verifies the installed command reports 0.61.0. Java CI uses Temurin; local verification uses the installed OpenJDK build with the same version, so distribution-specific hosted behavior remains unverified until CI runs.

Client CI pins the already published Mirrors commit `0bd67c954cac0f8e04599ee083355589a3f88035`. Synchronous Counter output is intentionally stable while the asynchronous emitter uses a separate target. A coordinated source change can supply the full published SHA through `workflow_dispatch.mirrors_ref` or local `MIRRORS_REF`; mutable branch names are rejected. Once a new compatible server commit is published and verified, update the checked baseline in a normal review. No pin points to a future uncommitted change.

Mirrors CI checks its PR source against explicit published commits of MirrorECMA, MirrorCPP, MirrorRust, and ModelMirrors. Its `ecma_ref` manual input permits a full matching client SHA; otherwise `tools/ci/versions.env` owns the baseline. The matrix reports checkout revisions, dirty working files, and installed tool versions. `INTEROP_VERIFY_PINS=1` makes checkout and core tool mismatches fatal in hosted CI; local developers may exercise explicitly selected worktrees with their actual identities printed.

The broader workflow pins Rust 1.96.0, GHC 9.14.1, Cabal 3.16.1.0, and a Hackage index-state. Cargo uses `--locked`. GitHub action references are full verified commit SHAs. The runner image is `ubuntu-24.04`; OS package patch levels and C++ FetchContent dependencies still follow that image/repository's existing dependency policy. This design improves repeatability and records those tool versions; it does not claim a hermetic, bit-identical environment. A Haskell freeze file and a container digest are future extensions if that stronger guarantee becomes necessary.

## Failure semantics and acceptance

A wrong compiler revision fails with the actual/expected SHA and an explicit matching-revision instruction. A missing requested live tool fails before the test workload. A download/checksum/version failure aborts installation. The ordinary client gate needs no Haskell, Rust, C++, Java, or Apalache installation.

Acceptance checks include frozen-lock installation, shell syntax and actionlint, the exact focused entry point, offline correct/faulty Counter behavior, the downloaded pinned Apalache's real live acceptance, and portable Haskell TLS behavior where available. Run descriptions distinguish sandbox socket denial from test assertions. Full matrix and GitHub-hosted outcomes must be reported separately from these focused checks.

## Primary-source evidence

- [Node 24.15.0 release](https://nodejs.org/en/blog/release/v24.15.0) and [pnpm 11.22.0 release](https://github.com/pnpm/pnpm/releases/tag/v11.22.0): exact installed versions are published releases.
- [Apalache 0.61.0 release metadata](https://api.github.com/repos/apalache-mc/apalache/releases/tags/v0.61.0): versioned tarball SHA-256 `68fb56dd9d053cf21d692fd7ec3fbaaeba1395661ec7434fa2b4c47e6fc432b8`; installer was checked against this digest.
- [Temurin 25.0.4+7 release](https://github.com/adoptium/temurin25-binaries/releases/tag/jdk-25.0.4%2B7): published Java build selected for CI.
- [GHC 9.14.1 release checksums](https://downloads.haskell.org/~ghc/9.14.1/SHA256SUMS) and [Cabal 3.16.1.0 release checksums](https://downloads.haskell.org/~cabal/cabal-install-3.16.1.0/SHA256SUMS): published tool versions matching the current Haskell package constraints.
- [Pinned pnpm setup action](https://github.com/pnpm/action-setup/tree/b906affcce14559ad1aafd4ab0e942779e9f58b1) and [pinned Lean action](https://github.com/leanprover/lean-action/tree/50fcf42d2e460296f1a34b402e990d1b24f8b596): verified cache/package path and Lake package-directory inputs.
