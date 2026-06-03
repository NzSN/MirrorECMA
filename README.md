# MirrorECMA

TypeScript client for the [ModelMirros](https://github.com/NzSN/ModelMirrors) protocol — replay TLA+ traces against your state machine implementation over stdio.

## Install & Build

```bash
npm install
npm run build        # → dist/
npm run check        # type-check only
```

## Quick Start

```ts
import { runClient, getParamInt } from "mirrorecma";

const v = (n: number) => ({ tag: "int", val: BigInt(n) } as const);

await runClient(
  "/path/to/ModelMirros",
  "specs/Counter.tla",
  {
    invariant: "TraceComplete",
    lengthBound: 5,
    numTraces: 1,
    cinit: "CInit",
    paramVars: "parameters",
  },
  (action, params, prev) => {
    if (action === "init")
      return { count: v(0), step_count: v(0) };
    const stride = getParamInt(params, "parameters", "stride");
    return {
      count: v(Number(prev.count.val) + stride),
      step_count: v(Number(prev.step_count.val) + 1),
    };
  }
);
```

## API

### `runClient(binPath, specPath, config, compute)`

Connects to a ModelMirros binary via stdio, registers a spec, and replays all
traces. Throws on step mismatch or protocol error. Returns when `all_steps_done`
is received.

The `compute` function is called with:

| Event | Args | Expected return |
|---|---|---|
| `initial_state` | `(action, stateFromMirror, {})` | The initial state the client wants to report |
| `next_step` | `(action, params, prevState)` | The next state after applying the action |

### `presetClient(states)` → `StateComputer`

Returns a compute function that serves states from a pre-defined array in order.
Useful for deterministic specs and testing.

```ts
const states = [
  { count: v(0), step_count: v(0) },
  { count: v(1), step_count: v(1) },
  // ...
];
await runClient(bin, spec, config, presetClient(states));
```

### `TraceGenerationConfig`

| Field | Type | Description |
|---|---|---|
| `invariant` | `string` | Invariant to violate (Apalache `--inv`) |
| `lengthBound` | `number` | Max Next steps (Apalache `--length`) |
| `numTraces` | `number` | Number of counterexample traces (`--max-error`) |
| `cinit?` | `string \| null` | Constant initialization operator name (`--cinit`) |
| `paramVars?` | `string` | Variable to treat as action parameters |

### Value Helpers

```ts
getParamInt(state, "parameters", "stride")  // extract int from nested record
asInt(value)    // → bigint | null
asStr(value)    // → string | null
asRecord(value) // → Record<string, Value> | null
```

## Protocol

The client communicates with a ModelMirros process over stdio using
newline-delimited JSON. Message types (tagged by `proto_step`):

```
Client → Mirror:   register, report_state
Mirror → Client:   spec_validated, initial_state, step_ok,
                   next_step, step_mismatch, all_steps_done, protocol_error
```

Flow:

```
client                        mirror
  |                             |
  |-- register(spec, config) -->|
  |<-- spec_validated ----------|
  |<-- initial_state(action,s) -|
  |-- report_state(s) --------->|
  |<-- step_ok -----------------|
  |<-- next_step(action,params) |
  |-- report_state(s') -------->|
  |          ... repeat ...     |
  |<-- all_steps_done ----------|
```

## Value Format

State maps use the Apalache ITF value encoding:

| Type | JSON |
|---|---|
| Int | `{"#bigint": "42"}` |
| Bool | `true` / `false` |
| Str | `"hello"` |
| Set | `[{"#bigint": "1"}, {"#bigint": "2"}]` |
| Tuple | `{"#tup": [...]}` |
| Record | `{"field": value, ...}` |

In the tagged `Value` representation these become `{ tag: "int", val: 42n }`,
`{ tag: "record", val: { field: ... } }`, etc.
