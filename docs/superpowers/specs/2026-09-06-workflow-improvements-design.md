# Mirrors and MirrorECMA workflow improvements — coordinated design

Status: implemented and locally verified. This document coordinates six improvements;
the [implementation plan](../plans/2026-09-06-workflow-improvements.md) records
ownership, dependencies, and execution evidence.

## Outcomes

| Improvement | User-visible outcome | Detailed design |
| --- | --- | --- |
| 1. Structured diagnostics and reports | Inspect failures without parsing strings; retain precise inputs, observations, position, and coverage | [Replay runtime](2026-09-06-replay-runtime-design.md) |
| 2. Reproducible CI | A fresh checkout runs the same pinned toolchain and checks as local development | [CI](2026-09-06-reproducible-ci-design.md) |
| 3. Asynchronous implementation operations | Await real operations before observation and comparison, with explicit cancellation and deadlines | [Replay runtime](2026-09-06-replay-runtime-design.md), [async emission](2026-09-06-async-emission-design.md) |
| 4. Dynamic binding completion | Construct application resources after negotiation, support all descriptor types, and dispose failed bindings | [Dynamic binding](2026-09-06-dynamic-binding-design.md) |
| 5. A stronger behavioral example | Test queue ordering, duplicate requests, failure/retry, completion, and reset against an independent model | [Work queue](2026-09-06-work-queue-design.md) |
| 6. Reliable native rebuilds | Editing a C shim automatically recompiles and relinks every affected executable | [Native build](../../../../Mirrors/Docs/native-build-design.md) |

## Compatibility and shared interfaces

The frozen protocol and synchronous `StateComputer` type stay in
`src/protocol.ts`. Additive runtime types admit a synchronous or asynchronous
computer without redefining existing wire messages. Existing void-returning
client entry points remain; report-returning entry points are additive.

`ReplayContext` supplies an invocation signal and explicit replay coordinates:
trace numbers start at 1, state numbers at 0 (initial state). An asynchronous
computer completes its operation and observations before returning the state to
send. The runtime never advances to the next action before that return.

`ReplayOptions` admits an external signal and positive action/receive deadlines.
Abort or timeout ends replay and prevents subsequent reports. Binding code checks
the invocation signal before observing after an awaited operation and becomes
unusable after cancellation/failure. Cancellation is cooperative: it cannot undo
side effects from application code that ignores its signal. Cleanup ownership
and the precedence of the original error remain explicit.

Reports distinguish started/completed traces, reported/matched states, and
completed transitions. Action counts and adjacent action-pair counts are
aggregate data; the runner does not retain every successful state. Failure
snapshots contain cloned inputs, expected/actual states, diff hints, and replay
position. JSON conversion preserves arbitrary-precision integers through the
existing ITF encoding. A new `ReplayMismatchError` remains an `Error`, supports
structured inspection, and renders actual parameters rather than
`[object Object]`.

Dynamic factory selection carries contract and digest data before negotiation;
its factory supplies the handlers and cleanup after a validated descriptor.
Legacy pre-created registries remain available with their ownership limitation
documented. A failure while validating a newly created registry must dispose its
scope. Opaque values use an explicitly branded, validated, immutable wrapper;
ordinary objects cannot masquerade as opaque protocol values.

The asynchronous generated target is named `mirrorecma-async-v1`, with local
StateComputer contract `mirrors.async-state-computer/v1`. It shares language-
neutral descriptor identity with the synchronous target. Existing
`mirrorecma-v1` output bytes remain stable. This permits the current published
Mirrors compiler to remain a useful pinned baseline for synchronous CI while
the additive compiler target is developed in the matching worktree.

## Validation and rollout

Each stream publishes its design and task plan before dependent integration.
The runtime and dynamic workers agree on types first. Public barrel exports,
package scripts, example configuration, and root documentation have one owner
(the coordinator) to avoid concurrent edits.

Run focused behavioral tests while developing each stream. Final integration
includes all TypeScript checks and unit tests, generated Counter acceptance,
the new queue's valid/faulty executions, live Apalache replay, existing mTLS
negotiation smoke, compiler golden checks, and native rebuild regression.
Workflow syntax and local CI commands are checked separately from actual hosted
GitHub Actions runs; hosted execution is not claimed without a run.

Machine restrictions are reported as environment failures. Run blocked local
subprocess/loopback checks with the needed permissions before classifying code.
Source and interface changes are complete only with corresponding execution
evidence. This work does not automatically publish commits, dispatch remote
workflows, or update repository branch references.
