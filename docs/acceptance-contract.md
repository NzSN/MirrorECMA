# Acceptance contract for reference integrations

This document fixes the deliverables and evidence shape for the reference
integration program across Mirrors, MirrorECMA, and MirrorGate. It applies to
every application integration, so results from different applications can be
compared and reviewed without re-deriving what was exercised.

The program's goal is a reusable answer to three questions per application:

- Does the framework deliver trustworthy behavioral evidence for this
  application class?
- Which deliberate implementation defects does it reject, at what evidence?
- What integration work does a third party still have to do by hand?

## Required deliverables per application

1. A behavioral model owned by the evaluator. Bounds, abstraction choices, and
   the operation set are stated; unsupported coverage is stated, not implied.
2. A public implementation contract sufficient to write a correct
   implementation without seeing the model or the held-out verification.
3. An adapter that observes actual application state. Observations must read
   persisted or live state, never cached or expectation-derived values.
4. A deterministic replay corpus (checked witness traces, no live model
   checker) plus a separate live-generation tier.
5. Seeded faults: mutations of the implementation, not of the observer or
   adapter. Each fault pins the exact first mismatch the witness must report.
6. A reproducible evaluation command, documented prerequisites, and a
   machine-readable receipt.
7. Cleanup verification: no application store, temporary directory, or child
   process may remain after success, cancellation, timeout, or rejection.

## Evidence receipt

Every acceptance run emits one JSON document with at least:

- A schema tag and generation time.
- Content digests of the model and the witness trace, and the identity of the
  runner executable and runtime.
- One entry per seeded fault: its mutation description, the pinned expected
  first mismatch (trace, state, action, failure code), the observed mismatch,
  and whether it matched.
- Per-fault replay progress: states matched and steps completed.
- Cleanup status: the store location and any remaining entries.

A fault counts as rejected only when the observed first mismatch matches the
pinned expectation. An action error, a timeout, or a failure to reject is not
evidence of detection and must be reported as such.

## Current status

The first application is the MirrorECMA WorkQueue reference integration.
`pnpm run example:queue:acceptance` runs the checked witness against the
correct implementation and nine seeded faults; each fault carries its pinned
mismatch in `examples/work-queue/acceptance.ts`. Persistent transfer and
controlled-clock lease integrations add four faults each. All three include
separate failure, timeout and cancellation controls. See the
[program commands and evidence](../examples/application-validation/README.md).

WorkQueue retains its progress-report receipt
`mirrorecma.work-queue-acceptance/v1` (one-based trace indices). The new compiled
suites use `mirrorecma.application-validation/v1` (zero-based trace indices).
Gate receipts retain model outcome and physical cleanup separately. These are
application evidence schemas, not changes to the library's report or wire
protocol. The common obligations above apply to all three; do not compare raw
trace indices across report contracts without accounting for their base.

## Measurement

Each integration records, or explicitly marks unmeasured: time to first valid replay, handwritten integration
code size, seeded defects detected, evaluation wall time, and time to diagnose
one planted failure. Coverage claims report trace depth, action counts, and
action-pair counts next to any pass count.
