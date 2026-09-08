# Idempotent work queue — behavioral example design

Status: implemented and verified. This example exercises multiple actions and
asynchronous application operations beyond the Counter tutorial.

## Model and implementation

Use a small work queue with positive integer job IDs. Model observations are pending IDs
in FIFO order, one in-flight ID (0 means none), a completed-ID set, and a failed
flag. Operations are Initialize, Enqueue(id), Start, Fail, Retry, Complete, and
Reset. Enqueuing an ID already pending, in flight, or completed is idempotent.
Start takes the oldest pending item; failure retains it; retry enables another
completion attempt; completion records the ID; reset clears all state.

The implementation is independent application code. Prefer a small filesystem-
backed store using Node promises and a temporary directory: operations load,
update, and persist actual state; observers read it back. Store ownership and
cleanup belong to the negotiated factory. The adapter never reads expected
trace state or synthesizes missing observations.

The companion contract maps stable action/input IDs to the model and declares
only the four implementation observations. A `parameters` record contains the
Enqueue input and any trace-generation step counter; it is excluded from
reported observations by `paramVars`. The main transition relation describes
all valid operations. A separate deterministic witness transition operator
selects an instructive path through duplicates, failure/retry, completion, and
reset for reproducible generation and regression.

The supplied ITF evidence/trace must be checked against actual model execution,
not invented as an independent oracle. Generate the witness with Apalache,
resolve/check a v1 lock, and generate the ordinary typed output for provenance.
The runnable async adapter may use factory-backed dynamic descriptor binding
with the same verified contract/digest and explicit local handlers. This keeps
the example compatible with the published v1 compiler baseline.

## Runs and assertions

Default local stdio replay uses the checked trace and needs no live Apalache.
`--live` generates the witness from source; `--broken` selects a deliberately
faulty implementation whose Enqueue omits duplicate suppression. The same
adapter observes both. The negative must fail at a duplicate enqueue because
the actual pending sequence diverges, not because of invalid input or missing
tools.

The report must cover every declared action and the instructive pairs
Enqueue/Enqueue, Fail/Retry, Retry/Complete, and Reset/Enqueue. Pair coverage
resets at each trace boundary. Reset must reinitialize actual implementation
state, and factory cleanup removes the temporary store after success or failure.
Coverage describes these executed paths, not exhaustive state-space coverage.

Files live under `examples/work-queue/`, with a dedicated model/artifact tree and
standalone smoke harness. Reuse the public async/report/negotiation interfaces.
The Counter remains the short first tutorial; this is the linked next example.

## Implemented witness and validation

The witness has 16 states and 15 transitions. It queues 1 twice, then 2;
starts 1; submits a duplicate while 1 is in flight; fails/retries/completes 1;
submits a completed duplicate; starts/completes 2; resets; and enqueues,
starts, and completes 2 again. The general `Next` relation remains independent
of the `WitnessNext` selector. Offline replay repeats this trace twice, so
Initialize must clear the preceding completed set. Pair coverage must omit
the artificial Complete/Initialize boundary between traces.

Application operations serialize bigint IDs as decimal strings and use Node
promise-based file reads/writes plus rename. The store is explicitly a
single-worker example, not a concurrent or crash-durable queue. It supports
positive bigint IDs beyond the model's finite domain; a focused test verifies
precision above 2^53. Observers read persisted data on each invocation.

The adapter uses factory-backed async dynamic binding with generated v1
identity metadata. Successful descriptor negotiation precedes allocation;
rejected digest negotiation never calls the factory. The runner supplies
10-second action deadlines and 30-second offline / 180-second live receive
deadlines. Signals pass through every operation and observer. The runner
awaits cleanup after success, mismatch, or registry rejection.

`regenerate.mjs` runs actual Apalache 0.61.0, requires its deliberate witness
exit 12, preserves ITF metadata, runs compiler resolve/generate/preflight, and
records source/trace hashes. The smoke runs compiler check, detects stale output
without repair, checks all actions/pairs, rejects the faulty queue at trace 1
state 2, verifies success/failure cleanup, and optionally generates live traces.
All of these gates, the example type-check/build, and three focused tests passed.
