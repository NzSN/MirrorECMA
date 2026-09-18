# Reports, asynchronous replay, and binding ownership

For concurrent validation/trace-generation jobs on a remote model server, see [remote server usage](remote-server.md).
Server jobs are separate from the asynchronous implementation operations described here.

Start with the [generated Counter](../examples/generated-counter/README.md).
Use these APIs when an application needs machine-readable results, asynchronous
operations, or explicit resource lifetime. The [work queue](../examples/work-queue/README.md)
provides the next runnable example with multiple actions, failures, retries,
reset, and sequence coverage.

These are client-local capabilities. They preserve ordinary `register`,
`register_traces`, and `report_state` messages and the version-1 semantic
descriptor. Server asynchronous jobs through `Connection` remain a separate
protocol capability.

For externally authored or isolated implementations, see the accepted
[implementation boundary](implementation-boundary-design.md). MirrorECMA keeps
generic negotiation/replay/binding semantics; the coordinating agent talks to
Gate directly and a separate trusted integration supplies an implementation
proxy. The Gate-aware facade is available from the external `/legacy` entry
point after the [2.0 cutover](migration-v2.md); core has no managed-agent author option.

The [MBT harness design](mbt-harness-design.md) describes source-code test and
service entry points sharing one suite and deferred implementation factory.
The service wrapper projects allowed reports without changing replay semantics;
its proposed start/query/cancel protocol is not an existing MirrorECMA API.

## Run reports

The existing trace runners still return `Promise<void>`. Use their additive
variants when you need a successful `ReplayReport`:

| Existing entry point | Report-returning variant |
| --- | --- |
| `runClient` | `runClientWithReport` |
| `runClientWithTraces` | `runClientWithTracesWithReport` |
| `runClientNegotiated` | `runClientNegotiatedWithReport` |
| `runClientWithTracesNegotiated` | `runClientWithTracesNegotiatedWithReport` |

Arguments stay the same. Errors still throw; the report does not turn a failed
run into a successful return value. Both families attach partial progress to
object/function exceptions through `replayReportFromError`. Primitive thrown
values and failures before the replay lifecycle starts have no attached report.

```ts
import {
  ReplayMismatchError,
  replayReportFromError,
  runClientWithTracesNegotiatedWithReport,
  type ApalacheConfig,
  type NegotiatedAdapterSelection,
} from "mirrorecma";

export async function replayAndReport(
  binary: string,
  config: ApalacheConfig,
  tracePaths: string[],
  selection: NegotiatedAdapterSelection,
): Promise<void> {
  try {
    const report = await runClientWithTracesNegotiatedWithReport(
      binary, config, tracePaths, selection,
    );
    console.log(JSON.stringify(report));
  } catch (error) {
    if (error instanceof ReplayMismatchError) {
      console.error(error.code, error.traceIndex, error.stateIndex, error.action);
    }
    const report = replayReportFromError(error);
    if (report !== undefined) console.error(JSON.stringify(report));
    throw error;
  }
}
```

`ReplayReport.schema` is `mirrorecma.replay-report/v1`. The immutable snapshot
contains status, recorded duration, optional negotiated `interfaceDigest`, trace
and state progress, matched transition count, action/sequence counts, and an
optional structured failure. Initialization is state index **0**; trace indices
are **one-based**. Duration excludes transport readiness and final cleanup.
`stepsCompleted` counts matched transitions and excludes
initialization. `statesReported` can exceed `statesMatched` on a mismatch.

`actionCounts` uses **wire action labels** and counts states sent to Mirrors,
including a subsequently rejected state. `sequenceCounts` records adjacent
reported actions within each trace; it resets at initialization. These differ
from a generated binding's `coverage()`, which uses stable action IDs and counts
successfully constructed observations. Neither measure proves state-space
coverage or unobserved application behavior.

Aggregate memory is bounded: `coverage.actionLimit` is 256 distinct action
labels and `coverage.sequenceLimit` is 1,024 distinct adjacent pairs. Existing
entries continue counting after a cap. Omitted events increase
`droppedActionEvents` or `droppedSequenceEvents`, and `coverage.truncated` becomes
true. Total trace/state/step counters remain independent of those caps. The
report retains the failing step's details, not a full history of all states.

`ReplayMismatchError` retains immutable protocol `State` values in `params`,
`expected`, and `actual`, plus ordered `hints`. Those raw values contain native
`bigint`. Its `toJSON()` and the report's failure fields encode integers with
ITF `{"#bigint":"9007199254740993"}` values, preserving every digit through
`JSON.stringify`. Use those serialization paths instead of converting integers
to JavaScript `number`. Other failures keep their own codes and exception
identity; cleanup does not replace an earlier failure with a mismatch.

## Compiled execution reports

The negotiated `WithReport` functions support both report contracts. A selection
without a top-level `execution` field uses the `ReplayReport` progress snapshot
described above, including deferred dynamic scopes. A compiled selection with
`execution: "sync"` or `execution: "async"` returns `CompiledReplayReport`:
`status: "completed"`, `acceptedTraces`, `acceptedSteps`, `actionCoverage`, and
`diagnostics`. This path uses `deadlines.registrationMs`, `deadlines.stepMs`, and
`deadlines.receiveMs`, including bounded factory and cleanup waits.

`ReplayMismatchError` identifies both paths. Progress failures use
`code: "step_mismatch"` and one-based `traceIndex` with `stateIndex`; compiled
failures use `code: "replay_mismatch"` and zero-based `traceIndex` with `stepIndex`.
`replayReportFromError` retrieves progress snapshots; `replayCleanupFailure`
retrieves secondary cleanup evidence from compiled execution failures.

## Asynchronous operation ordering

The synchronous `StateComputer` type remains unchanged. Ordinary trace runners
accept `ReplayComputer`, whose fourth argument carries local replay context:

```ts
import type { State, ReplayCallbackContext } from "mirrorecma";

type ReplayComputer = (
  action: string,
  params: State,
  previousState: State,
  context: ReplayCallbackContext,
) => State | Promise<State>;
```

`AsyncReplayComputer` requires a `Promise<State>`. Existing three-argument
synchronous callbacks remain assignable. The trace runner awaits one computer
invocation before sending its state or receiving the next stimulus. An
asynchronous generated/dynamic binding performs input validation, awaits one
action, awaits its observation pass, encodes the complete observation, then
returns the state. Initializers must finish resetting the actual SUT before
their observation runs. Failures poison the binding; overlapping calls are
rejected. Promise settlement must mean the operation is observable by the SUT's
observer; scheduling work and returning early is insufficient.

Symbolic explorer entry points retain their documented synchronous interface.
The new options and generated async profile apply to ordinary trace replay.

## Cancellation and timeouts

The ordinary legacy and negotiated trace runners accept these optional fields:

| Option | Meaning |
| --- | --- |
| `signal` | Caller cancellation signal; abort produces `replay_aborted`. |
| `actionTimeoutMs` | Budget for one computer invocation, including its action, observation, and encoding; expiry produces `action_timeout`. |
| `receiveTimeoutMs` | Budget for one inbound message wait, including the registration reply; expiry produces `receive_timeout`. |

Omitted deadlines leave that operation without a timer. Values must be finite,
positive, and at most 2,147,483,647 milliseconds. `ReplayCallbackContext` carries a
terminal `signal`, `traceIndex`, and `stateIndex`; callback computers and
async dynamic handlers receive it. Forward the signal to application I/O and
check it at meaningful commit boundaries.

After abort or timeout, the runner sends no later state from the unfinished
operation. Late promise rejections are consumed, bindings become unusable, and
the negotiated runner attempts owned cleanup. Cancellation cannot roll back an
external mutation or forcibly stop a promise, CPU-bound JavaScript, or an I/O
library that ignores the signal. Cleanup may run while such ignored work is
still settling; the application must make disposal safe in that situation.

These are per-action/per-receive limits, not an end-to-end run deadline.
Transport readiness, adapter/registry factory initialization, and disposal are
awaited outside those timers. They need their own application/transport bounds
where required. Cancellation during factory initialization is checked after
the factory settles; any returned scope is then cleaned up. A blocked event
loop delays timer delivery, although a completed over-budget action is checked
before its state can be sent.

## Generated asynchronous ports

`mirrorecma-v1` continues to emit the synchronous port used by Counter. Use the
separate `mirrorecma-async-v1` target with a matching current Mirrors compiler:

```bash
MODEL_INTERFACE_GEN=/absolute/path/to/Mirrors/.lake/build/bin/model_interface_gen
COUNTER_FIXTURES="$PWD/test/fixtures/model-interface/counter"

"$MODEL_INTERFACE_GEN" generate \
  --lock "$COUNTER_FIXTURES/Counter.mirror-interface.lock.json" \
  --target mirrorecma-async-v1 \
  --out "$COUNTER_FIXTURES/generated-async"
```

The [generated async Counter](../test/fixtures/model-interface/counter/generated-async/CounterMirror.generated.ts)
has this port shape; the generated input and observation records are unchanged:

```ts
import type { ReplayContext } from "mirrorecma";

interface TickInput { readonly stride: bigint }
interface CounterObservation { readonly count: bigint }
interface CounterAsyncPort {
  initialize(context: ReplayContext): Promise<void>;
  tick(input: TickInput, context: ReplayContext): Promise<void>;
  observe(context: ReplayContext): Promise<CounterObservation>;
}
```

The `bindCounterAsync` binding exposes `AsyncStateComputer`, which receives
`{ action, payload, previous }` and a `ReplayContext` containing `signal` and
an absolute monotonic `deadline`. Cancellation poisons the binding; the
application factory owns resource disposal. Register it through
`AsyncCompiledAdapterRegistry` with `execution: "async"`, using `MIRRORECMA_ASYNC_TARGET_PROFILE` and
`ASYNC_STATE_COMPUTER_CONTRACT_VERSION`, whose exact values are
`mirrorecma-async-v1` and `mirrors.async-state-computer/v1`. The synchronous key
uses `MIRRORECMA_TARGET_PROFILE` and `STATE_COMPUTER_CONTRACT_VERSION`. The
[async Counter acceptance executable](../test/async-generated-counter.smoke.ts)
shows an explicit adapter from the generated input/context API to the callback
runner, retaining progress reports. The
[reusable MBT Counter](../examples/mbt-counter/README.md) uses the compiled
execution API directly with a supplied implementation factory.

The semantic lock, descriptor schema, canonical digest, negotiation bytes, and
ITF state encoding are shared with the synchronous target. Target profile and
local computer contract remain separate fields of the exact adapter key. Use
a separate generated directory and the compiler's matching `check --target`
command; running an async computer does not require an async server-job API.
The [CI pins](../scripts/ci/versions.env) deliberately retain a published compiler
baseline for synchronous artifacts; async regeneration needs the compiler
revision containing this separate target.

## Dynamic factory scopes

Use `createRegistry` to defer construction until a descriptor has been fully
verified. The factory receives the effective config and verified descriptor and
returns one local scope. `execution: "async"` selects asynchronous callbacks;
`"sync"` or omission selects the synchronous binder, which rejects promises.

```ts
import {
  DescriptorCache,
  semanticDigestFromHex,
  type ContractV1,
  type DynamicHandlerFactorySelection,
} from "mirrorecma";

interface AsyncCounter {
  reset(signal: AbortSignal): Promise<void>;
  increment(stride: bigint, signal: AbortSignal): Promise<void>;
  readCount(signal: AbortSignal): Promise<bigint>;
  close(): Promise<void>;
}

export function selectDynamicCounter(
  contract: ContractV1,
  digest: string,
  createCounter: () => Promise<AsyncCounter>,
): DynamicHandlerFactorySelection {
  return {
    mode: "dynamic",
    policy: "require",
    contract,
    semanticDigest: digest,
    descriptorCache: new DescriptorCache(),
    createRegistry: async () => {
      const counter = await createCounter();
      return {
        execution: "async",
        registry: {
          semanticDigest: semanticDigestFromHex(digest),
          actions: {
            Initialize: (_inputs, context) => counter.reset(context.signal),
            Tick: (inputs, context) => {
              if (typeof inputs.Stride !== "bigint") throw new Error("invalid stride");
              return counter.increment(inputs.Stride, context.signal);
            },
          },
          observations: { Count: (context) => counter.readCount(context.signal) },
        },
        dispose: () => counter.close(),
      };
    },
  };
}
```

Pass this selection to an ordinary negotiated trace runner. Stable handler and
observer IDs must exactly match the descriptor. Factory construction happens
after schema, digest, cache, and authorization checks; returned-scope validation
can still fail. Once the factory returns, the runner attempts its `dispose`
exactly once on success or any subsequent failure, including registry binding
failure. If creation throws before returning a scope, the factory owns cleanup
of partially acquired resources. A cleanup error stays secondary to the
original failure.

The prebuilt `registry` selection remains supported. The library can defer its
callback invocation but cannot defer a SUT already constructed by its caller.
Use the factory form to meet the zero-construction-before-verification
requirement. Each session receives a fresh binding and resources; descriptors
only supply inert data and never supply handler code.

## Opaque descriptor values

The dynamic binder supports descriptor `opaqueItf` values through the branded
`OpaqueItfValue` wrapper, including when nested in supported typed containers:

```ts
import { opaqueItfValue, OpaqueItfValue } from "mirrorecma";

const token = opaqueItfValue({ tag: "int", val: 9007199254740993n });
console.log(OpaqueItfValue.is(token)); // true
const inertValue = token.value; // deeply readonly protocol Value snapshot
```

Input projection produces this wrapper; an opaque observer must return one.
The wrapper validates, copies, and deeply freezes a protocol `Value`, preserving
constructor distinctions and arbitrary-precision integers. It rejects malformed
values, cyclic data, duplicate set elements/map keys, and structures exceeding
the exported depth/node limits. A native record or variant cannot impersonate
the wrapper. Inspect `token.value` as inert data; use normal typed observations
where the application needs a structural type contract.

Opaque support belongs to the local dynamic interpreter. It does not widen the
portable generated profile: both current TypeScript emitters still reject an
opaque lock type with `MIC-E-TYPE-001`. No descriptor or report schema changes
are needed for dynamic opaque values.

## Checked application suites

The additive [application suite API](application-suites.md) derives exact compiled
selection from a generated model handle, checks corpus/source provenance before
construction, requires explicit `step_ok` acceptance evidence, and joins local
cleanup with an independent budget. Use `defineSuite` with `runSuite` for native
adapters or `runSuiteWithFactory` for trusted generic providers. Existing replay
APIs, reports, and their diagnostic counting semantics remain unchanged.
