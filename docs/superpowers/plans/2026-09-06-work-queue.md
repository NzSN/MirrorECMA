# Work queue example — implementation plan

Status: implemented and verified. Design: [work queue](../specs/2026-09-06-work-queue-design.md).

- [x] Define the independent Queue TLA+ model, deterministic witness operator,
  action/input/observation contract, and reset/idempotency semantics.
- [x] Generate a real Apalache witness trace; preserve its type evidence and
  source provenance. Resolve/check the semantic lock, generate v1 source, and
  run preflight requiring every action.
- [x] Implement independent asynchronous queue storage plus deliberately
  faulty duplicate handling; make observation read actual persisted state.
- [x] Implement a deferred dynamic handler factory, signal-aware action calls,
  cleanup ownership, and report-returning replay/live runner.
- [x] Add package build/run/smoke entries and example TypeScript inclusion
  through the coordinator; retain existing Counter entries.
- [x] Test supplied replay, live generation, duplicate-request failure,
  required action/pair coverage, reset, and store cleanup.
- [x] Document model/implementation mapping, actual failure report, artifact
  regeneration, and the limits of the exercised witness.

Done: the example drives real async state changes, verifies all named paths,
and detects its faulty implementation through ordinary observed-state mismatch.

## Execution evidence

- Ownership: `work_queue` implemented `examples/work-queue/**`, the standalone
  smoke and three focused tests; coordinator integrated package scripts and
  TypeScript inclusion. Existing runtime and compiler workers supplied the
  additive public async/report/factory APIs.
- Actual Apalache 0.61.0 generated the 16-state witness; compiler resolve,
  v1 generation, required-action preflight, and read-only freshness check passed.
  `regenerate.mjs` reran that whole artifact workflow successfully.
- `pnpm run build:examples` passed. `pnpm test --runInBand --no-watchman
  test/work-queue.test.ts` passed three tests (bigint persistence and honest
  observation, cancellation/disposal, deferred allocation).
- Actual offline runner matched 32 states and completed 30 transitions across
  two traces. Faulty runner exited 1 at trace 1, state 2, `enqueue`, with pending
  expected `[1]`, actual `[1, 1]` and structured mismatch data.
- `APALACHE_MC=/home/nzsn/.local/bin/apalache-mc node
  dist-test/test/work-queue.smoke.js --live` passed provenance, compiler check,
  stale output rejection without repair, positive/negative replay, all required
  actions/pairs, trace reset boundaries, rejected negotiation without allocation,
  cleanup after success/failure, and live Apalache generation/replay.
- Subprocess capture restrictions first caused sandbox-only empty runner output
  and `spawnSync EPERM`. The real generator and smoke were rerun with subprocess
  permission and passed. No hosted CI execution is claimed by this local gate.
