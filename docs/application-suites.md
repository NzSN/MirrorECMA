# Checked application suites

The additive suite API composes generated async model handles, checked trace
corpora, required negotiation, explicit matched evidence, and bounded local
cleanup. Existing replay APIs and both low-level report schemas retain their
semantics. MirrorECMA has no Gate dependency; a trusted integration may supply
an `AsyncAdapterFactory` through `runSuiteWithFactory`.

```ts
import { defineSuite, runSuite } from "mirrorecma";
import { CounterModel } from "./generated/Counter.suite.js";

const suite = defineSuite({
  id: "counter/v1",
  model: CounterModel,
  replay: {
    kind: "corpus",
    config: {
      specPath: "./model/Counter.tla", invariant: "TraceComplete",
      lengthBound: 6, constInit: "CInit", paramVars: "parameters",
    },
    traces: ["./traces/counter.itf.json"],
  },
  acceptance: { requiredActions: ["Tick"], requiredPairs: [["Tick", "Tick"]] },
});
const result = await runSuite(suite, {
  mirror: "/prepared/bin/mirror",
  implementation: async (context) => {
    const { createAdapter } = await import("./adapter.js");
    const port = await createAdapter(context);
    return { port, dispose: () => port.dispose?.() };
  },
});
```

The generated handle uses `mirrors.suite-model/v1`, the existing
`mirrorecma-async-v1` target, `mirrors.async-state-computer/v1`, and the separate
`mirrors.node-native/v1` representation identity. `bindLocal` consumes native
adapter values; `bindPublicPort` consumes the existing compiled representations.
A generic provider supplies its compiled binding directly and bypasses the local
conversion bridge.

`defineSuite` performs no filesystem, transport, timer, or application work. It
validates descriptor identity, metadata/projection consistency, portable types,
public manifest consistency, replay settings, and stable transition requirement
IDs. It snapshots and freezes input data. The trusted generated functions retain
their identity. An omitted adapter ID becomes `suite.local`.

`preflightSuite` performs explicit file I/O. It checks the ordered nonempty trace
occurrences, strict ITF constructors, parameter metadata, input projection and
observation types, and generated source provenance when available. A generated
`provenance.sources` list pins the full dependency closure resolved by
`specFromFiles`; `provenance.modelSha256` pins the root. A trace reference may be
a path or `{path, sha256, serverPath?}`. Declared hashes are checked before
opening a model connection or invoking the application factory. The ordered
corpus digest is SHA-256 of UTF-8 JSON
`{"schema":"mirrorecma.corpus/v1","traces":[...ordered file SHA-256 strings]}`.
Repeated paths remain separate occurrences. At most 4096 traces are supported.
The returned identities record hashes even when a direct caller selected plain
paths without declaring expected hashes.

For a remote server, `replay.modelSource` names the local reviewed root while
`replay.config.specPath` retains its server-visible meaning. `serverPath` likewise
separates each remote trace reference from its locally checked copy. This API
does not upload files or prove remote/local file byte equality; required
negotiation verifies the interface, and the explicit occurrence/action sequence
checks detect replay order drift. The evaluator must arrange the selected remote
corpus deployment. A model digest does not identify a corpus or configuration.

## Acceptance evidence

The suite opts into strict collection in the existing replay loop. Initialization
and transition observations remain pending after `report_state`; only the
corresponding `step_ok` commits them. A new action, duplicate acknowledgement, or
terminal message cannot manufacture an acknowledgement. The final state requires
an explicit acknowledgement before `all_steps_done`. Trace state counts and
stable operation sequences must agree with preflight. Aliases resolve through
the immutable descriptor, and pair adjacency resets at every initialization.

Requirements allow at most 256 actions and 1024 pairs. Initializers and unknown
stable IDs are rejected. All required counters are allocated before execution,
independently of legacy diagnostic coverage limits. Counters fail closed at
`Number.MAX_SAFE_INTEGER`; an overflow makes evidence uncertain and cannot prove
absence or success. The public evidence encodes exact counts as decimal strings.
No counter wraps, rounds, or silently truncates.

`evaluateAcceptance(requirements, evidence)` is pure:

| Status | Meaning |
| --- | --- |
| `met` | All selected initialization/transition states completed and required matched coverage exists |
| `unmet` | Complete exact evidence proves at least one required count is zero |
| `incomplete` | Replay stopped or a required counter/completion fact is unavailable |
| `not_evaluated` | Replay was never entered |

Empty requirements still require a complete matching corpus. Generated binding
coverage and the existing progress recorder remain diagnostics with their
previous semantics; they are not sources of strict matched evidence.

## Lifetime and results

The default budgets are registration 60 seconds, action 10 seconds, receive
60 seconds, and cleanup 10 seconds. Each accepts a positive integer through
2147483647 milliseconds. An action budget covers its operation and observation.
Cleanup has one independent shared budget for connection close, late factory
settlement/disposal, and local operation quiescence.

`SuiteConstructionContext` contains only `signal`, an absolute monotonic
`deadline`, and `deferCleanup(fn)`. Register partial allocations as they occur.
Registrations stay owned on both successful and failed construction. The helper
returns a memoized disposer; use that returned wrapper when the implementation's
disposer adopts a registered resource. At cleanup the handle's sole `dispose`
runs once, followed by remaining registered wrappers in reverse order. Calling
an adopted wrapper again does not release its resource twice. Do not wrap and
call the original raw disposer again; use the returned wrapper. The runner never
also calls `port.dispose`. Resources that were neither registered nor returned
remain the factory's responsibility.

| Event | Result |
| --- | --- |
| Invalid preflight or denied negotiation | No implementation factory/action/observer calls |
| Factory returns after deadline | No replay; join its disposer within cleanup budget |
| Factory never settles | Bounded return with unconfirmed cleanup/quiescence |
| Operation times out and ignores cancellation | No late state report; raw native operation stays pending until settled |
| Disposal completes but an operation remains pending | Quiescence remains unconfirmed |
| Partial allocation or disposal fails | Preserve primary failure and report cleanup failure separately |
| Full matched corpus misses coverage | `failed`, acceptance `unmet`, code `coverage_unmet` |
| Model rejects a reported state | `mismatch`, with zero-based trace/state coordinates |

Raw native handler promises are tracked before the generated bridge so a
binding's cancellation race cannot falsely prove application quiescence. Generic
providers cannot expose those raw promises; action timeout/cancellation therefore
retains unconfirmed local quiescence. Gate separately joins physical isolation
cleanup. Local completion never establishes physical termination. A JavaScript
CPU loop can delay its own deadline timer.

Each run creates one factory scope and reinitializes it for every selected
trace. Per-run transports are owned and closed; a deferred connector can be
provided as `() => Transport | Promise<Transport>`. Closing a connection to an
existing server does not terminate that server. A local binary target owns its
spawned process through the existing transport.
An already supplied transport transfers ownership even when preflight rejects;
a deferred connector is never called for invalid or pre-cancelled input. All
early connection/iterator failures use the independent cleanup budget.
`cleanup.bindingStatus` is `not_started` when no factory was invoked, independent
of cleanup for an acquired model connection.

`SuiteResult` is additive. Overall `passed` requires matched conformance, met
acceptance, and successful applicable cleanup. Mismatch, cancellation, and timeout
retain primary precedence over secondary cleanup failures. A user-thrown object
or counterfeit mismatch exception cannot become a model mismatch. Failure
classification uses guarded structured data; the original rejection is retained
as non-enumerable `trustedError`. The result and optional compiled report are
trusted evaluator evidence, not an approved public disclosure projection.
