# Deterministic scheduling (experimental)

MirrorECMA owns a real Node worker-thread coordinator. The first profile is
`mirrorecma.worker-checkpoints/v1`. It controls intervals between declared
checkpoints; it does not intercept arbitrary promises, browser Web Workers,
instructions, clocks, randomness or threads created outside the adapter.

The implementation and cross-client acceptance plan live in Mirrors
`Plans/dpm-mirrorecma-mirrorrust.md`; retained qualification belongs to the exact
package/artifact record, not merely this API declaration or package version.

## Workers and the controller

A `WorkerScheduleAdapter` declares a model/mapping/implementation identity,
actor/operation pairs, checkpoint names and a deferred `factory(inputs)`.
The factory returns a `WorkerProgram` containing file-URL worker modules, their
structured-clone data, a synchronous observer and teardown. A private bootstrap
parks each real worker before importing application code. A worker module exports:

```js
export async function run(input, checkpoint) {
  const local = Atomics.load(new Int32Array(input.buffer), 0);
  await checkpoint.arrive("read");
  Atomics.store(new Int32Array(input.buffer), 0, local + 1);
  await checkpoint.arrive("write");
}
```

`await` preserves the operation's local state. Only the permitted actor advances;
all others remain parked. Returning from `run` supplies `$done`. Completion is
observed only after the worker's actual exit, including its remaining event-loop
work. Application modules must put controlled work inside `run`; imports occur
within the first interval. Shared state remains the application's responsibility;
the example uses SharedArrayBuffer plus Atomics.

`startWorkerSchedule` admits the complete plan before the factory, parks workers
and observes actual initial state. `advance({actor,checkpoint})` must equal the
next admitted interval. The checkpoint names the destination of that interval.
`finish()` requires the complete plan; `runWorkerSchedule` drives all intervals.
An unexpected actual checkpoint, premature return, callback exception or wrong
controller call fails explicitly. Observations require quiescence and cannot
wait for actors or reenter scheduling. Cancellation cannot release workers while
a synchronous observer is still reading shared state.

An optional `program.request(actor, input, signal)` handles bounded worker RPCs.
`checkpoint.request(input)` may run only inside a permitted interval. The native
application bridge uses it to send Begin/Advance commands to an owned Windows
process. The process reports actual phases/state; the portable coordinator never
runs inside a trap handler. Logical proxy workers and native actors have separate
identities and lifetimes.

## Ownership, cancellation and bounds

The execution handle owns its workers. Cancellation opens owned waits; it cannot
force arbitrary application code to cooperate. `cleanup(timeoutMs)` reports
`incomplete` and names remaining actors when necessary. Retain the handle, release
application-owned waits, then retry cleanup. The owned Worker is never unreferenced or detached, and no forced termination
is performed. After the callback settles, only its private bootstrap channel
is unreferenced so the event loop can drain; late checkpoint calls still fail
and the controller still waits for the real worker exit. A hard termination requirement needs a separate process owner.

Factory, observer, teardown and custom RPC/runner callbacks are trusted code and
must return promptly. Budgets cannot preempt synchronous main-thread JavaScript
or an arbitrary callback. An application must not park while holding a resource
its observer needs. External effects and undeclared threads remain outside this
profile's control.

Direct scheduling bounds are 64 actors, 65,536 intervals, 128-character IDs,
65,535-byte inputs/individual observations, 8 MiB execution evidence and positive
execution/cleanup budgets up to 24 hours. Receipts retain ordered permits/arrivals,
actual observations, Node worker IDs, fresh execution identity, primary outcome,
completion and independent cleanup evidence. IDs are correlation data, not access
credentials. Replay equality excludes fresh execution/thread identifiers.

## Generated replay

`ScheduleBindingSession` owns executions across generated async callbacks. Its
constructor acquires no SUT; initialization creates a fresh generation, action
callbacks advance exact intervals, and observation returns implementation state.
The connection-local binding must call session disposal. Disposal cancels and
joins a pending callback/late factory before teardown; repeated disposal preserves
its original result. Cleanup retry updates ownership evidence without turning a
failed replay into a pass. Session retention is bounded to 64 executions/16 MiB.

`replayScheduledTraces` uses the ordinary negotiated runner and captures the real
peer terminal verdict separately from client and scheduler cleanup failures.
An empty peer verdict cannot earn overall success without a complete execution.
A genuine mismatch retains expected/actual states and ordered hints; failed
cleanup does not overwrite it. Keep expected model state out of the factory and
observer.

The counter uses unchanged `mirrorecma-async-v1` generation. The native pilot uses
explicit `mirrorecma-async-v2` generation for integer-keyed maps, with the same
async StateComputer contract and strict generated codecs. Its lower-level
compiled replay selection uses the exported v2 target constant. Existing v1
output, synchronous APIs and wire bytes are unchanged. Suite bundles/project
onboarding remain on their existing async-v1 profile; a v2 suite-bundle profile
is not advertised by this change.

## Finite exploration and packages

`exploreFiniteSchedules` exhaustively merges fixed actor-local chains over an
explicit finite input list. Switching away from an unfinished actor counts as a
preemption; switching after `$done` does not. The initial explorer admits at most
8 actors, 64 total intervals, 64 inputs and 4,096 enumerated shapes. Execution,
time and evidence limits remain explicit. Unknown denominators stay unknown;
truncation, invalid evidence, missing required comparison and unconfirmed cleanup
cannot report completion. The local runner exposes its last execution for
cleanup ownership.

Coverage uses canonical typed states: sets are extensional, map order is ignored,
map keys remain homogeneous integer/string values with duplicates rejected, and
sequence/tuple order and ordinary record keys are preserved. Only explicitly
listed instrumentation fields are omitted. Model counterexamples remain visible
independently of cleanup failure. Local execution coverage does not establish
that every explored schedule conforms to the model. No POR is enabled.

`SCHEDULING_CAPABILITIES` is an experimental declaration exported by the ordinary
package. Concrete qualification is a separate hash-bound observation. Run
`pnpm run test:schedule` for real-worker regressions. Mirrors' cross-client gate
builds packed consumers with source checkouts hidden, then performs generated
replay, finite coverage and the bounded native pilot from admitted artifacts.
