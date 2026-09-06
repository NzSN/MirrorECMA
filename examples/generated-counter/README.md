# Connect a real Counter to Mirrors

This tutorial connects an ordinary TypeScript implementation to a generated
model interface. Mirrors replays a model trace, the adapter invokes real
operations and observes real state, and Mirrors compares those observations
with the expected model states.

## 1. Start with the implementation

[counter.ts](counter.ts) contains the system under test (SUT). It imports
nothing from MirrorECMA:

```ts
export class Counter {
  count = 0n;

  reset(): void {
    this.count = 0n;
  }

  increment(stride: bigint): void {
    this.count += stride;
  }
}
```

The [TLA+ model](specs/Counter.tla) initializes `count` to zero and permits
increments by 2 or 3. The
[companion contract](../../test/fixtures/model-interface/counter/Counter.mirror-interface.json)
identifies the application operations and observation:

| Contract ID | Model meaning | Implementation mapping |
| --- | --- | --- |
| `Initialize` | `init` | `counter.reset()` |
| `Tick` | `tick`, with input at `parameters.stride` | `counter.increment(stride)` |
| `Count` | Observe `count` | Read `counter.count` |

Mirrors generates a typed port and binding from the contract and structural
type evidence. The checked-in
[generated source](../../test/fixtures/model-interface/counter/generated/CounterMirror.generated.ts)
includes:

```ts
export interface TickInput {
  readonly stride: bigint;
}

export interface CounterObservation {
  readonly count: bigint;
}

export interface CounterPort {
  initialize(): void;
  tick(input: TickInput): void;
  observe(): CounterObservation;
}
```

## 2. Map the generated port to your code

The handwritten [adapter.ts](adapter.ts) supplies this mapping:

```ts
const port: CounterPort = {
  initialize: () => counter.reset(),
  tick: ({ stride }) => counter.increment(stride),
  observe: () => ({ count: counter.count }),
};
```

`createCounterRun()` prepares a `CompiledAdapterRegistry` selection with
`policy: "require"`. It uses the generated `CounterModelInterface` and
`CounterSemanticDigest` together with the library's target-profile and
StateComputer-contract constants. The registered factory constructs the Counter,
port, and `bindCounter(port, config)` only after a validated `matched` reply.
Selecting the correct or broken constructor does not create a SUT early.

The generated binding decodes inputs, calls the appropriate handler, collects
observations, encodes arbitrary-precision integers, and checks its lifecycle.
Neither the Counter nor this port uses the expected model state to calculate
its answer. The negotiated runner owns transport closure and binding disposal;
Counter needs no external cleanup. A SUT that owns resources would release
them in the returned binding's `dispose()`.

These files use `../../src/index.js` to compile against this checkout's public
barrel. Installed consumers import the same public APIs from `mirrorecma`.

## 3. Build and verify the tutorial inputs

Use Node.js, pnpm, and the
[Mirrors build prerequisites](https://github.com/NzSN/Mirrors#requirements).
Run all commands from the **MirrorECMA repository root**, including commands
later in this tutorial. Set the absolute path to your Mirrors checkout:

```bash
pnpm install
export MIRRORS_ROOT=/absolute/path/to/Mirrors
(cd "$MIRRORS_ROOT" && lake build mirror model_interface_gen)
pnpm run check:examples
```

The runner defaults `MIRRORS_ROOT` to the sibling `../Mirrors` checkout. Its
binary defaults to `$MIRRORS_ROOT/.lake/build/bin/mirror`; set `MIRROR_BIN` to
an absolute executable path to override it. Model and trace paths are resolved
absolutely before the local stdio session starts. A missing tool or input is
an error.

Define reusable compiler paths and verify the checked-in model, lock, and
output. These commands are read-only:

```bash
MODEL_INTERFACE_GEN="$MIRRORS_ROOT/.lake/build/bin/model_interface_gen"
COUNTER_MODEL="$PWD/examples/generated-counter/specs/Counter.tla"
COUNTER_FIXTURES="$PWD/test/fixtures/model-interface/counter"

cmp "$COUNTER_MODEL" "$MIRRORS_ROOT/specs/Counter.tla"

"$MODEL_INTERFACE_GEN" check \
  --spec "$COUNTER_MODEL" \
  --contract "$COUNTER_FIXTURES/Counter.mirror-interface.json" \
  --evidence "$COUNTER_FIXTURES/counter.itf.json" \
  --param-var parameters \
  --lock "$COUNTER_FIXTURES/Counter.mirror-interface.lock.json" \
  --target mirrorecma-v1 \
  --out "$COUNTER_FIXTURES/generated"

"$MODEL_INTERFACE_GEN" preflight \
  --lock "$COUNTER_FIXTURES/Counter.mirror-interface.lock.json" \
  --trace "$COUNTER_FIXTURES/counter.itf.json" \
  --require-all-actions
```

A clean `check` exits zero and compares the expected lock, ownership manifest,
and generated output without repairing them. Preflight validates the trace
against the lock and requires every declared action: the supplied trace has
three states, one `Initialize`, and two `Tick` executions.

The tutorial model is a byte-identical copy of `Mirrors/specs/Counter.tla`.
MirrorECMA's separate root `specs/Counter.tla` serves older examples and differs
from this model. The companion contract's logical source name remains
`specs/Counter.tla`; the compiler normalizes the physical input path to that
logical identity.

The shared [fixture directory](../../test/fixtures/model-interface/counter/)
is the single source for the contract, structural evidence, lock, generated
TypeScript, and ownership manifest. The supplied `counter.itf.json` contains
`#meta.varTypes` declarations used as type evidence and states used for replay.
Those checked-in declarations bootstrap this tutorial; trace values alone do
not establish structural types for another model.

## 4. Replay the known trace

[run.ts](run.ts) uses this configuration for both replay and live mode:

```ts
const config: ApalacheConfig = {
  specPath: model,
  invariant: "TraceComplete",
  lengthBound: 6,
  constInit: "CInit",
  paramVars: "parameters",
};
```

`paramVars: "parameters"` treats that model variable as action stimuli. Its
`stride` reaches `tick()`, while the implementation reports only the `count`
observation. The generated binding handles the wire representation.

Run the example:

```bash
pnpm run example:counter
```

The command builds the example into ignored `dist-test/` and calls
`runClientWithTracesNegotiated` with the supplied trace. It starts Mirrors over
local stdio and does not invoke Apalache. Trace paths belong to the mirror's
filesystem; this example keeps both processes local.

After the pnpm build output, the result is:

```text
Counter replay passed.
Action coverage: {"Initialize":1,"Tick":2}
```

The runner calls `assertAllActionsCovered()` after successful replay and prints
the generated binding's action counts. A pass establishes agreement between
actual observations and expected states on the exercised traces. Action counts
identify executed handlers; they do not measure state-space coverage or prove
all application behavior.

## 5. Detect a real implementation bug

`BrokenCounter` changes the implementation's increment in [counter.ts](counter.ts):

```ts
export class BrokenCounter extends Counter {
  override increment(stride: bigint): void {
    this.count += stride - 1n;
  }
}
```

The same adapter still reads the actual `counter.count`. Run it with:

```bash
pnpm run example:counter:broken
```

This demonstration intentionally exits **1**. On the first `tick`, the supplied
stride is 2, the model expects 2, and the implementation reports 1. The current
client diagnostic is:

```text
step mismatch on action "tick" with param "[object Object]": at count: expected 2, got 1
```

The failed comparison is the protocol's terminal `step_mismatch`. The runner
preserves the mismatch and does not replace it with a coverage error. A missing
binary or file also fails the command, but does not demonstrate bug detection.

The automated tutorial gate checks that distinction, model provenance, artifact
freshness without repair, and successful replay with Apalache unavailable:

```bash
pnpm run smoke:generated-counter
```

## 6. Generate fresh traces with Apalache

Provide an Apalache executable and run the same adapter with live generation:

```bash
APALACHE_MC=/absolute/path/to/apalache-mc pnpm run example:counter:live
```

The runner also accepts `apalache-mc` on `PATH`. A requested live run fails
when the tool is missing. It uses `runClientNegotiated`, sends the tutorial model
with `specFromFiles(model)`, and requests `{ numTraces: 1, view: "View" }`.
The Counter configuration above uses `TraceComplete` (`count < 12`) as a
trace-producing invariant: its counterexample supplies the replay steps. The
length bound is 6; changing the model or bound changes which behavior can be
exercised. Successful runs print `Counter live run passed.` and action counts;
the particular generated trace can vary. Include this tier in the automated
gate with:

```bash
APALACHE_MC=/absolute/path/to/apalache-mc pnpm run smoke:generated-counter --live
```

## Regenerate after changing the model contract

The first replay uses checked-in generated artifacts. When intentionally
updating this shared example, first reconcile its authoritative model, companion
contract, and structural evidence. Then resolve the lock and generate its owned
output using the variables from step 3:

```bash
"$MODEL_INTERFACE_GEN" resolve \
  --spec "$COUNTER_MODEL" \
  --contract "$COUNTER_FIXTURES/Counter.mirror-interface.json" \
  --evidence "$COUNTER_FIXTURES/counter.itf.json" \
  --param-var parameters \
  --lock "$COUNTER_FIXTURES/Counter.mirror-interface.lock.json"

"$MODEL_INTERFACE_GEN" generate \
  --lock "$COUNTER_FIXTURES/Counter.mirror-interface.lock.json" \
  --target mirrorecma-v1 \
  --out "$COUNTER_FIXTURES/generated"
```

`resolve` writes the semantic lock; `generate` owns the paths tracked by
`generated/.model-interface-generated.json`. Keep the generated TypeScript and
manifest under compiler ownership, and put handwritten adapters outside that
directory. Preserve unowned files. Repeat the `check` and required-action
`preflight` commands from step 3, then type-check and run the tutorial gate.

For a different application, create its own model, companion contract,
structural evidence, and generated-output directory. Choose which model inputs
map to actual operations and which implementation state the observer reports.
Generation supplies types and protocol handling; you author that semantic
mapping. Update the adapter only after generating the corresponding port, and
construct each SUT inside the matched registry factory. The
[compiler design](https://github.com/NzSN/Mirrors/blob/main/Docs/model-interface-compiler-design.md)
describes supported evidence and publication rules.

For further modes, see [compiled verification and dynamic descriptors](../../README.md#verified-generated-bindings),
[low-level customization](../../README.md#low-level-customization),
[symbolic exploration](../../README.md#architecture),
[transports](../../README.md#transports), and
[async server jobs through `Connection`](../../src/connection.ts). Dynamic descriptors bind explicitly
provided local handlers; they do not automatically adapt an application.
