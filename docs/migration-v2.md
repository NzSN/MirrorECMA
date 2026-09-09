# MirrorECMA 2.0 source migration

Status: version 2.0.0 is the integrated breaking source cutover, with
hash-verified destination integration and local validation completed. The initial
separate preparation checkout is historical; it is not the current delivery
state. Full cross-client interop passed (`INTEROP MATRIX GREEN`). This does not publish a package
or create a tag. See [Gate workflow validation](https://github.com/NzSN/MirrorGate/blob/main/docs/managed-workflow-validation.md) for authoritative evidence.

## Core API and dependency boundary

All generic protocol, transport, negotiation, generated binding, registry,
replay, cancellation and report APIs retain their behavior. MirrorECMA accepts
an implementation factory or binding. It does not receive Gate policy, sessions,
agent prompts, build plans or control frames. There is no optional Gate peer and
no forwarding import from core to the external integration.

Callers using the former Gate-specific facade must install compatible local
packages and change those imports to `mirrorgate-mirrorecma/legacy`. That
Gate-owned package retains the old plan/author callback/disclosure/cleanup shape;
it is currently a private package validated through local packing. Keep an
explicit 1.0.0 pin for consumers that have not migrated. Do not install an
unpublished package name from the registry as part of normal evaluation.

```ts
import { AsyncCompiledAdapterRegistry } from "mirrorecma";
import {
  evaluateSandboxed, createSandboxCompiledModel,
  type SandboxEvaluationPlan,
} from "mirrorgate-mirrorecma/legacy";
```

Every removed root export has the same name under that `/legacy` entry point:

| Removed root module | Exact exports now owned by `mirrorgate-mirrorecma/legacy` |
| --- | --- |
| `sandbox-model` | `SANDBOX_PUBLIC_MANIFEST_SCHEMA`, `SANDBOX_ASYNC_TARGET_PROFILE`, `SANDBOX_ASYNC_COMPUTER_CONTRACT`, `SandboxModelError`, `createSandboxPublicManifest`, `createSandboxCompiledModel`, `SandboxPortableType`, `SandboxPublicManifest`, `SandboxPortOperation`, `SandboxPortObservation`, `SandboxReplayContext`, `SandboxNativePort`, `SandboxAsyncBinding`, `SandboxAuthoringBundle`, `SandboxCompiledModel`, `PreparedSandboxModel`, `GeneratedSandboxAsyncBinding`, `GeneratedSandboxModelInput` |
| `sandbox` | `evaluateSandboxed`, `sandboxDiagnosticFailures`, `SANDBOX_AUTHORING_OUTPUT_BYTES`, `SandboxWorkerRuntime`, `TrustedGateLauncher`, `SandboxGateEndpoint`, `SandboxInputRef`, `SandboxSubmission`, `SandboxReplayRequest`, `SandboxTightenedLimits`, `SandboxAuthoringExecResult`, `SandboxAuthoringSession`, `SandboxDisclosurePolicy`, `SandboxCleanupStatus`, `SandboxFailureFamily`, `PublicEvaluationResult`, `TrustedSandboxDiagnostic`, `SandboxEvaluationPlan`, `SandboxEvaluationOptions` |

## Source, command and evidence migration

| Previous source/command | Replacement |
| --- | --- |
| `src/sandbox.ts`, `src/sandbox-model.ts` | Gate integration implementation and `/legacy` exports |
| Four `test/sandbox-*.test.ts` suites | Same named suites in `MirrorGate/integrations/mirrorecma/test/`; manifest, facade, author output and failure coverage retained |
| `test/sandbox-counter.smoke.ts` | Gate integration `test/legacy-matrix-driver.ts`; installed public imports and public SDK telemetry preserve all TypeScript matrix scenarios |
| `tsconfig.sandbox.json` | Gate integration `tsconfig.matrix.json` plus installed `scripts/matrix-consumer.mjs` acceptance setup |
| `examples/sandbox-counter/` | Gate integration prepared implementation example and `scripts/prepared-smoke.mjs`; local source/CLI tests use `examples/mbt-counter/` |
| `check:sandbox`, `build:sandbox`, `smoke:sandbox` | Gate `conformance/control-v1/run` for the full 42-row matrix, and integration `node scripts/packed-consumer.mjs --sandbox` for prepared-consumer checks |
| `example:sandbox-counter` | Gate-owned optional integration consumer; use its documented installed workflow and approved operator inputs |
| `experiments/blind-counter/evaluator.mjs` | Helper compatibility runner imports public `mirrorecma`, `mirrorgate-mirrorecma/legacy`, `mirrorgate/control` and `mirrorgate/worker`; generated fixture remains compiler-owned |
| Helper evaluator `mirrorEcmaCompiledRoot` | Still an explicit fixture/evidence root, now `dist-test`; it no longer supplies private library imports |
| Required-backend CI | Core boundary check plus Gate-owned installed-package matrix runner; all 42 existing rows and evidence schemas remain unchanged |

The historical `experiments/blind-counter/results/2026-09-08/` tree is unchanged.
Its author-host helpers remain a historical compatibility route; migration of
imports does not claim that this runner launches through managed Gate hosting.
The new normal path calls Gate directly and supplies its factory to generic MBT.

## Package acceptance

`package.json`, `package.bazel.json` and the root Bazel module select 2.0.0. The pnpm lockfile was
regenerated offline with pnpm 11.22.0; its importer records no package version or
optional non-installed peer, so the locked dependency graph remains byte-identical.
Build/prepare clears `dist` first to prevent removed sandbox files surviving in
a tarball after an incremental build.

`test/package-boundary.test.ts` checks the core source/export graph and metadata.
`pnpm run check:package-boundary` packs and extracts the public package into a
fresh consumer with neither Gate package, compiles strict public declarations and
the unchanged compiler-generated binding, and runs the same local Counter suite.
It checks successful MBT/reports, a real model mismatch, pre-factory cancellation
and cancellation/disposal of a late binding. `MIRROR_BIN` is required; there is no
mock comparison or silent skip in this package gate.

Generic Jest/source tests remain independent of Gate. Required model transport,
private fixtures, and the Mirrors server are evaluator inputs; this package test
does not claim isolation. Gate's separate packed integration and 42-row matrix
prove the external import migration and restricted worker behavior. Actual fresh
agent dispatch, credentials and managed workflow remain their own acceptance.

## Integrated validation status

The destination `ci --live` gate passed with all 424 tests and pinned Apalache
0.61.0. Gate's full gate, 142 integration tests and all 42 shared control-matrix
rows passed. Installed source-test, CLI, MCP and service entry points passed
against the same suite. A real Codex author produced committed source through
Gate; restricted build and two authorized mTLS evaluations against the same
Mirrors server passed with confirmed cleanup and preserved server lifetime.

These are integrated local results, not an isolated prototype or publication.
The central cross-client gate also reported `INTEROP MATRIX GREEN`, covering
ECMA, C++, Rust and Haskell plus stdio, TCP and mTLS tiers. Its result is recorded
in the
[authoritative Gate validation ledger](https://github.com/NzSN/MirrorGate/blob/main/docs/managed-workflow-validation.md).
