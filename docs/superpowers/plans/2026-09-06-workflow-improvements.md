# Workflow improvements — assigned implementation plan

Status: implemented and locally verified on 2026-09-06.

Design: [coordinated design](../specs/2026-09-06-workflow-improvements-design.md).

## Detailed plans

- [Structured reports and asynchronous replay](2026-09-06-replay-runtime.md).
- [Reproducible CI](2026-09-06-reproducible-ci.md).
- [Dynamic binding ownership and opaque values](2026-09-06-dynamic-binding.md).
- [Generated asynchronous target](2026-09-06-async-emission.md).
- [Work queue example](2026-09-06-work-queue.md).
- [Native incremental builds](../../../../Mirrors/Docs/native-build-plan.md).

## Assignment and ownership

| Stream | Owner | Files owned | Dependencies |
| --- | --- | --- | --- |
| Reports and async replay | `replay_runtime` | Replay modules, `client.ts`, `negotiated.ts`, runtime tests, stream design/plan | Agree context/factory types with dynamic worker |
| Dynamic completeness | `dynamic_binding` | `dynamic-binding.ts`, opaque-value module, dynamic tests, stream design/plan | ReplayContext type; factory integration by runtime owner |
| Reproducible CI | `reproducible_ci` | Workflows, CI scripts/config, Mirrors interop scripts including existing tutorial block, stream design/plan | Published compiler baseline; native regression handoff |
| Native incremental builds | `native_build` | Mirrors `lakefile.lean`, native regression script, Ffi README, stream design/plan | Pinned Lake interfaces |
| Async generated target | Coordinator; `replay_runtime` for emitted-code tests | Async TypeScript emitter, compiler/CLI allowlist, focused emitter tests, stream design/plan | Runtime types agreed; no synchronous golden drift |
| Work queue example | `work_queue` | Queue model/contract/evidence/lock/generated files, SUT/adapter/runner and smoke, stream design/plan | Reports + async factory binding |
| Integration | Coordinator | Public `src/index.ts`, package scripts/tool pin, example tsconfig, README/AGENTS, master status | All stream handoffs |

Workers preserve pre-existing uncommitted changes, avoid modifying another
owner's files, and send dependency requests to the owner. The previous Mirrors
tutorial/interop changes remain part of the working tree and must be preserved.

## Execution sequence

- [x] S1: Write the six designs/plans and shared context, report, factory,
  opaque-value, and async target contracts.
- [x] S2: Implement structured failure snapshots and additive report runners;
  verify bigint serialization, coordinates, sequence counts, and legacy calls.
- [x] S3: Await asynchronous computation with abort/deadline handling; verify
  ordering, late resolution/rejection, transport closure, and cleanup precedence.
- [x] S4: Implement opaque values, async dynamic binding, factory-only resource
  construction, post-disposal rejection, and construction-failure cleanup.
- [x] S5: Fix CI package manager/tool/revision selection and add a focused
  client pipeline that does not depend on the other language clients.
- [x] S6: Replace shim mtime shortcuts with Lake tracked native dependencies;
  run isolated edit/relink/no-op/header/options regression.
- [x] S7: Add an opt-in generated async TypeScript target; verify it awaits
  operation and observation and leaves existing target bytes unchanged.
- [x] S8: Add the work-queue model and independent SUT, checked artifact
  provenance, replay/live runs, duplicate-request bug, and sequence assertions.
- [x] S9: Integrate public exports/scripts/docs; run combined verification and
  review all cross-stream error/lifecycle behavior.
- [x] S10: Record exact outcomes, remaining platform/hosted-CI limitations, and
  final file scope without claiming unexecuted checks.

## Required acceptance evidence

1. Legacy Counter fixture bytes and synchronous caller behavior remain valid.
2. A mismatch exposes stable coordinates, raw typed values, JSON-safe output,
   useful text, and a bounded aggregate report.
3. Async actions complete before observation/reporting; cancellation and
   timeout stop the replay and preserve one cleanup path.
4. Factory-based dynamic negotiation creates zero application resources on
   refusal; invalid newly created registries dispose once; opaque data roundtrips.
5. A clean frozen pnpm install and the focused CI entry point work using explicit
   tool/repository inputs; workflow syntax is valid.
6. A shim-only edit relinks the affected executables automatically, and a no-op
   build stays stable. Isolated regression leaves original source bytes intact.
7. The new asynchronous emitted port executes against a real async adapter;
   compiler ownership and semantic identity remain valid across target profiles.
8. The queue succeeds through duplicate/retry/reset paths and detects a real
   faulty implementation using the same honest observer.
9. Combined unit/type/golden/live/transport checks pass in the required local
   environment. Full remote or Windows coverage is identified separately.


## Final integration evidence

- `MIRRORS_ROOT=/home/nzsn/Repos/Mirrors APALACHE_MC=/home/nzsn/.local/bin/apalache-mc bash scripts/ci/check.sh --live` passed: all three project type checks, **16 Jest suites / 385 tests**, Counter source/golden/preflight/stale checks and offline/live replay, real asynchronous filesystem Counter (valid and typed mismatch), and work-queue artifact/offline/live/negative/cleanup checks.
- `APALACHE_MC=/home/nzsn/.local/bin/apalache-mc lake test` passed the full Mirrors driver, including the new async compiler gate, frozen wire/diff corpora, model-interface suites, explorer, transport, registry, Counter and async gates. The filesystem race test now supplies a valid ownership manifest so it reaches the intended publication race under stricter target checking.
- Compiler sync output remains byte-identical; async output is deterministic, carries the same semantic identity, and cannot overwrite another target's owned tree. The generated async port passed awaited ordering, cancellation, disposal, and adversarial reentrancy tests.
- The isolated native gate passed source/header/compiler/include/library changes, affected executable linking, and repeated no-op checks; original C source bytes were unchanged. Full runtime transport coverage passed through `lake test`.
- The exact pinned clean/frozen client installation, both workflow actionlint checks, and portable Haskell mTLS positive/negative checks passed locally.
- Cross-review defects were fixed and retested: capped aggregates with truncation metadata; readiness-failure cleanup; nonthrowing diagnostic extraction and primitive rejection preservation; post-encoding lifecycle check; own-property record encoding/decoding for opaque protocol labels.
- Root public exports, package scripts/tool pin, all example TypeScript targets, guides, and task statuses are integrated.
- Existing compiled/dynamic Counter smoke also passed separately over real
  stdio and mTLS, including descriptor cache reuse, wrong digest/observer, and
  allowlist/descriptor-read authorization negatives.

Windows native execution, hosted GitHub Actions, and the complete external
C++/Rust/Haskell matrix were not run. These are explicit platform/hosted limits,
not substituted with local success. No commits or pushes were made for this
implementation.
