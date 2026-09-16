# An asynchronous, idempotent work queue

This is the next example after the [generated Counter](../generated-counter/README.md).
Mirrors drives a real filesystem-backed queue through enqueue, dispatch,
failure/retry, completion, and reset. Each operation awaits disk I/O; the
observers reload persisted application state before comparison with the
independent TLA+ model.

This is an implemented async application example. The
[reusable harness design](../../docs/mbt-harness-design.md) describes the
implemented Counter source-test/CLI/service pattern around generic MBT semantics;
see the [Counter suite](../mbt-counter/README.md). An
external implementation provider may use a proxy; a service proxy requests an
entire evaluation. Neither is required for this example.

Run these commands from the MirrorECMA repository root, after `pnpm install`:

```bash
# Build the local server and compiler in the sibling Mirrors checkout:
(cd ../Mirrors && lake build mirror model_interface_gen)

# Replay the checked Apalache witness; this needs no live Apalache.
pnpm run example:queue

# Intentionally fails on the second enqueue of job 1, with exit code 1.
pnpm run example:queue:broken

# Generate the witness from source, then replay through the same adapter.
APALACHE_MC=/absolute/path/to/apalache-mc pnpm run example:queue:live
```

Set `MIRRORS_ROOT` when Mirrors is elsewhere. `MIRROR_BIN` can override its
executable. The checked witness was generated with Apalache 0.61.0. The default
run replays it twice in one session to verify that initialization clears state
left by the preceding trace.

## What is tested

| Model operation | Real queue behavior |
| --- | --- |
| Initialize | Write empty persisted state, including on the next trace |
| Enqueue(id) | Append a positive ID unless pending, in flight, or completed |
| Start | Remove the oldest pending job and mark it in flight |
| Fail | Retain the in-flight job and mark its attempt failed |
| Retry | Clear the failed flag so the same job can complete |
| Complete | Add the in-flight ID to the completed set and free the worker |
| Reset | Clear pending, in-flight, completed, and failed state |

The [application](queue.ts) accepts arbitrary positive `bigint` IDs and has no
protocol dependencies. Its temporary store contains a JSON file; each
sequential operation reads, updates, writes a temporary file, and renames it
into place. `0n` denotes no in-flight job. This small example assumes one
sequential worker; it does not implement concurrent producers, process crash
recovery, or a production durable queue.

The [model](specs/WorkQueue.tla) uses IDs 1 and 2. `Next` describes every valid
application transition. `WitnessNext` selects this deterministic path through
those same transitions:

```text
init
enqueue(1), enqueue(1), enqueue(2), start
enqueue(1), fail, retry, complete, enqueue(1)
start, complete, reset, enqueue(2), start, complete
```

This checks FIFO order with two queued jobs, duplicate requests in all three
phases, failure/retry, and reuse of a completed ID after reset. The final state
contains a completed job, so replaying a second trace checks actual
initialization. `parameters.step` selects witness positions;
`paramVars: "parameters"` excludes that step counter and operation inputs from
implementation observations.

## Adapter and resource ownership

The [companion contract](artifacts/WorkQueue.mirror-interface.json) maps stable
action/input IDs and declares pending sequence, in-flight ID, completed set,
and failed flag observations. The compiler resolves types from the actual
Apalache trace's `#meta.varTypes`, produces the semantic lock, and emits
[v1 TypeScript metadata](artifacts/generated/WorkQueueMirror.generated.ts).

The [adapter](adapter.ts) uses asynchronous dynamic handlers with that exact
contract and digest. Its selection contains metadata and a deferred
`createRegistry` factory. Mirrors accepts the interface and MirrorECMA validates
the descriptor before the factory allocates the queue directory. Each handler
passes the invocation's `AbortSignal` to the application; every observer reads
the actual store. The completed `Set<bigint>` becomes an array at the descriptor
binding boundary, where it is encoded as an ITF set.

The example uses established v1 compiler artifacts for identity and provenance.
Its generated synchronous port does not execute the asynchronous queue; the
local asynchronous registry supplies that behavior explicitly. The server
descriptor supplies data, never executable handlers.

The runner owns the factory's `dispose` callback and removes the directory on
success or failure. Actions have a ten-second deadline. Reads and writes accept
the signal, with cancellation checks between awaits; cancellation cannot undo
a completed write. Each operation and its observations finish before the next
operation starts.

## Results and the deliberately broken implementation

A passing offline run prints `Work queue replay passed.` and a JSON
`Replay report:` with two completed traces, 32 matched states, and 30 completed
transitions. The report includes action counts and adjacent action-pair counts.
The example requires every action plus `enqueue → enqueue`, `fail → retry`,
`retry → complete`, and `reset → enqueue`. Pair counting resets at trace
boundaries.

`BrokenWorkQueue` omits duplicate suppression. The same adapter and observers
report actual pending state `[1n, 1n]` where the model expects `[1n]`. Failure
occurs at trace 1, state 2, action `enqueue`. The JSON report exposes
`failure.code: "step_mismatch"`, inputs, expected/actual states, and a hint at
`pending[1]`; integers retain their `#bigint` encoding. This command
intentionally exits 1.

These assertions describe the exercised witness. They do not establish
exhaustive state-space or concurrency coverage.

## Seeded-fault acceptance

`pnpm run example:queue:acceptance` extends the single `BrokenWorkQueue`
demonstration into a small fault matrix. It first replays the checked witness
against the correct implementation, then replays the same witness, adapter,
and observers against nine deliberately faulty implementations. Each fault is
rejected only when the reported first mismatch matches its pinned expectation
(trace, state, action, `step_mismatch`), so a change that hides a fault or
turns it into an action error fails the run.

| Fault | Mutation | Pinned first mismatch |
| --- | --- | --- |
| `duplicate-accepts` | repeated Enqueue is appended | trace 1, state 2, `enqueue` |
| `enqueue-drops` | first Enqueue stores nothing | trace 1, state 1, `enqueue` |
| `enqueue-in-flight` | an in-flight job is also left pending | trace 1, state 5, `enqueue` |
| `start-stale` | Start marks job 2 though job 1 was queued | trace 1, state 4, `start` |
| `fail-does-not-mark` | Fail leaves the failed flag false | trace 1, state 6, `fail` |
| `retry-does-not-clear` | Retry keeps the job failed | trace 1, state 7, `retry` |
| `complete-keeps-in-flight` | Complete records the job but keeps it in flight | trace 1, state 8, `complete` |
| `complete-stale` | Complete records job 9 instead of the running job | trace 1, state 8, `complete` |
| `reset-leaves-state` | Initialize keeps the previous trace's state | trace 2, state 0, `init` |

`--json` prints the machine-readable receipt: model and witness digests, the
runner and runtime identities, correct-run coverage, separate crash/hang/cancel controls, per-fault expected/observed mismatches, replay
progress, and cleanup status. The documented contract for this evidence shape
and for the remaining applications is
[`docs/acceptance-contract.md`](../../docs/acceptance-contract.md).

The default acceptance command now uses [`suite.ts`](suite.ts) and the generated
`WorkQueueModel` with [`native-adapter.ts`](native-adapter.ts). Build the shared
application validation target first (`pnpm run build:application-validation`).
The compiler owns native collection conversion; suite evidence counts only
acknowledged matches. The table above retains the historical one-based trace
coordinates: v2 compiled receipts use traces 0/1 for the same states/actions.
The old `runQueueAcceptance` helper and its regression test remain for comparison.

The mutations live in `acceptance.ts`; the seams they use are the small
protected methods on `WorkQueue`. The adapter and the observation path are
shared with the correct implementation, so a fault is detected through real
persisted state rather than through a fault-specific observer.

```bash
# Human-readable fault matrix, exit 1 if any fault is missed:
pnpm run example:queue:acceptance

# Same run with the full receipt:
pnpm run build:application-validation && node dist-test/examples/work-queue/acceptance-cli.js --json

# Persist an exclusive owner-only receipt:
node dist-test/examples/work-queue/acceptance-cli.js --receipt /private/new-queue-receipt.json

# Focused in-process acceptance test:
NODE_OPTIONS="--experimental-vm-modules" node node_modules/jest/bin/jest.js test/work-queue.acceptance.test.ts --runInBand
```

## Checking and regenerating artifacts

The checked [witness](artifacts/witness.itf.json) retains Apalache's original
type and origin metadata. [Provenance](artifacts/provenance.json) records its
tool version, checking arguments, and SHA-256 hashes of model and trace.
`TraceComplete` deliberately becomes false at state 15 so Apalache emits the
witness; exit code 12 is expected for this trace-generation command.

```bash
# Read-only artifact check, stale-file rejection, executable runs,
# structured failure assertions, action/pair coverage, and cleanup:
pnpm run smoke:work-queue

# Include new trace generation and replay:
APALACHE_MC=/absolute/path/to/apalache-mc pnpm run smoke:work-queue --live

# Deliberately replace witness, provenance, lock, and generated artifacts
# after changing the model or contract:
APALACHE_MC=/absolute/path/to/apalache-mc node examples/work-queue/regenerate.mjs
```

Regeneration executes Apalache instead of constructing expected states. It
resolves/generates the interface and runs preflight requiring all actions.
The smoke harness runs compiler `check` without repairs, checks model/trace
provenance, confirms negotiation rejection allocates no store, and confirms
cleanup after passing and mismatched runs. `MODEL_INTERFACE_GEN` can override
the compiler executable.

The [three-application runner guide](../application-validation/README.md) adds
fresh-witness fault matrices and real Gate worker/authoring acceptance. The
WorkQueue model observes retry state, not a numeric retry counter.
