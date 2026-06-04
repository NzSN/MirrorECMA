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

### `StateComputer`

```ts
type StateComputer = (action: string, params: State, prevState: State) => State;
```

The function passed to `runClient`. Called on each step with the action name, the mirror's parameters (or initial state), and the previous computed state. Must return the next state as a `Record<string, Value>`.

### Value Helpers

```ts
getParam(state, "parameters")       // extract nested record from state
getParamInt(state, "parameters", "stride")  // extract int field from nested record
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

## Known Issues
### CJS output with `"type": "module"`

When built via Bazel's `ts_project(transpiler = "tsc")`, the compiled `.js` output is
CommonJS (`exports.*` / `require()`), but the source `package.json` declares
`"type": "module"`.  This mismatch means:

- **Node.js in ESM mode** (including Jest with `ts-jest/presets/default-esm`)
  cannot import named exports from the package — it sees `"type": "module"`,
  treats the `.js` files as ESM, and fails because they contain CJS syntax.
- **Jest cannot transform the module** because the default
  `transformIgnorePatterns` excludes `/node_modules/`.

#### Workaround (used by projects consuming MirrorECMA)

Create a local ESM wrapper that loads the CJS module via `createRequire` and
re-exports its symbols:

```bash
# In the consuming project's test / build script:
cp -rL "$(bazel-out)/node_modules/mirrorecma" node_modules/mirrorecma
chmod -R u+w node_modules/mirrorecma

# Create an .mjs wrapper (always ESM, regardless of "type" field):
cat > node_modules/mirrorecma/index.mjs <<'ESM'
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cjs = require("./src/index.js");
export const {
  runClient, presetClient, encodeClientMessage, encodeState,
  decodeMirrorMessage, asInt, asStr, asRecord, getParam, getParamInt,
  spawnMirror,
} = cjs;
ESM

# Override package.json to point main → index.mjs and set type → commonjs:
cat > node_modules/mirrorecma/package.json <<'PKGJSON'
{
  "name": "mirrorecma",
  "version": "1.0.0",
  "type": "commonjs",
  "main": "index.mjs",
  "types": "index.d.ts"
}
PKGJSON
```

This makes the CJS source files load correctly as CommonJS while exposing
proper named ESM exports to the consuming project.

#### Proper Fix

The root cause should be addressed in MirrorECMA's build configuration:
either compile to ESM output (e.g. set `"module": "es2022"` in tsconfig) or
remove `"type": "module"` from the package.json so the published package is
recognised as CommonJS.
