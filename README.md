# MirrorECMA

TypeScript client for the [ModelMirros](https://github.com/NzSN/ModelMirrors) protocol — model-based testing of state machines against TLA+ specs: replay model-generated traces or drive interactive symbolic exploration, over stdio or TCP.

## Architecture

The **TLA+ spec is the test oracle**; your TypeScript state machine is the
system under test (SUT). The mirror (ModelMirros) sits between the model
checker and your code: it obtains expected states from the model via
apalache-mc and conformance-checks every state the SUT reports
(variable-by-variable equality, `diffState`).

```
               model side                        SUT side
┌──────────────┐  JSON-RPC  ┌─────────┐ JSON-lines ┌──────────┐
│ apalache-mc  │◄──────────►│ mirror  │◄══════════►│ your SUT │
│ (CLI/server) │            │ (daemon)│ stdio | TCP│(this lib)│
└──────────────┘            └─────────┘            └──────────┘
     produces expected states        checks reported states
```

Three oracle modes, all transport-agnostic:

1. **Trace replay** (`runClient`, `runClientWithTraces`, `runClientGenTraces`)
   — apalache generates counterexample traces (an "invariant" like
   `step_count < N` is violated on purpose); the mirror replays them
   step-by-step and the SUT must reproduce every state.
2. **Mirror-driven symbolic MBT** (`runClientExplore`) — the mirror drives a
   live apalache explorer server, computing each successor state
   *symbolically* (no pregenerated trace), and checks state invariants after
   every step.
3. **Client-driven symbolic MBT** (`startExploreSession`) — the mirror proxies
   raw explorer commands; your test script controls the exploration:
   `assumeTransition`/`nextStep` to walk, `queryState` to read the oracle,
   `assumeState` to force concrete scenarios, `checkInvariant` to probe,
   `rollback` to backtrack.

**Physical separation:** spec sources (with their `EXTENDS` dependency
closure) travel inline inside `register`/`register_trace_gen`
(`specFromFiles`), and the mirror can run as a TCP daemon (`--serve <port>`)
— a remote mirror needs nothing but the apalache toolchain. `register_traces`
is the exception: its trace paths are mirror-local.

**The harness is itself model-checked:** the message layer conforms to
`ModelMirros/specs/MirrorProtocol.tla`, verified by MBT tests that replay
spec-generated protocol traces against the real mirror implementation.


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
  "/path/to/ModelMirros",          // binary path, or connectMirror(host, port)
  {                                 // ApalacheConfig
    specPath: "specs/Counter.tla",
    invariant: "TraceComplete",
    lengthBound: 5,
    constInit: "CInit",
    paramVars: "parameters",
  },
  { numTraces: 1 },                 // TraceGenerationConfig
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

### `runClient(target, apalacheConfig, traceConfig, compute, opts?)`

Connects to a ModelMirros binary, registers a spec, and replays all
traces. Throws on step mismatch or protocol error. Returns when `all_steps_done`
is received.

`target` is either a binary path (spawns the mirror over stdio) or a
`Transport` (e.g. `connectMirror(host, port)` — see TCP transport). `opts`
is an optional object: `{ spec?: ApalacheSpec }` — inline spec sources, see
Inline spec sources (when given, `apalacheConfig.specPath` is ignored by the
mirror).

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

### `runClientExplore(target, spec, invariants, exports, maxSteps, compute)`

Mirror-driven **interactive symbolic model checking**. Instead of replaying
precomputed concrete traces, the mirror starts a live apalache explorer server
and computes each successor state symbolically; your `compute` implementation is
conformance-checked against those states. The message flow is identical to
`runClient` (`spec_validated` → `initial_state`/`next_step` → … → `all_steps_done`).

```ts
const spec = await specFromFile("./specs/HourClock.tla");
await runClientExplore(bin, spec, ["Inv"], [], 4, computer);
```

| Arg | Description |
|---|---|
| `spec` | `ApalacheSpec` (`{ sources: string[] }`) — TLA+ source text; use `specFromFile` |
| `invariants` | Names of state-invariant operators, checked after every step |
| `exports` | Operator names declared for later `OPERATOR`-kind RPC queries. Unused by the mirror's current session commands — pass `[]` |
| `maxSteps` | Exploration depth; `all_steps_done` is sent when it is reached |

Differences from the trace flows:

- `next_step.parameters` carries the **full expected state** (not
  paramVars-extracted params), so a computer may echo it — but an independent
  implementation makes the check non-vacuous.
- The reported state must contain **every** state variable, including
  `action_taken` if the spec has one (the mirror derives action names from it).
  The `paramVars` omit-from-report rule does not apply.

### `startExploreSession(target, spec, invariants, exports)` → `ExploreSession`

Client-driven symbolic checking: opens an explorer session and lets you issue
explorer commands yourself; the mirror proxies each one to the apalache server.

```ts
const session = await startExploreSession(bin, spec, ["Inv"], []);
session.ready;            // { initTransitions, nextTransitions, stateInvariants }

await session.assumeTransition(0);   // → "ENABLED" | "DISABLED" | "UNKNOWN"
await session.nextStep();            // → step number
const state = await session.queryState();
await session.checkInvariant(0);     // → "SATISFIED" | "VIOLATED" | "UNKNOWN"
await session.assumeState({ hr });   // → "ENABLED" | "DISABLED" | "UNKNOWN"
await session.rollback(0);           // → snapshot id
await session.done();                // ends the session and closes the mirror
```

Commands and replies strictly alternate. A rejected command throws
(`protocol_error`) but the **session stays open** — you may keep issuing
commands. `invariantId` indexes into the `invariants` list passed at open.

### `specFromFile(path)` → `ApalacheSpec`

Reads a TLA+ file into the `{ sources: [text] }` shape expected by the explore
registration messages.

### `specFromFiles(rootPath, searchDirs?)` → `ApalacheSpec`

Reads a root TLA+ file **and its dependency closure** (`EXTENDS` / `INSTANCE`
clauses, resolved transitively as `<Name>.tla` next to the importing file, then
in `searchDirs`). When `searchDirs` is omitted it defaults to the
`TLA_LIBRARY_PATH` environment variable (colon-separated). Builtin modules
(`Naturals`, `Integers`, `Sequences`, …) are skipped. A module name found in
more than one directory is an **ambiguity error** (the wrong file would
otherwise be shipped silently). The result is `{ sources: [root, ...deps] }` —
root first, as apalache requires.

### Inline spec sources (remote mirrors)

`register` and `register_trace_gen` accept an optional `spec` field carrying
the spec's full source text. When present, the mirror materializes the sources
to a temp directory and **ignores `apalacheConfig.specPath`** — the mirror
never needs filesystem access to the client's files. This is what makes
running the mirror on another machine possible.

```ts
const spec = await specFromFiles("./specs/ExtMain.tla"); // resolves EXTENDS deps
await runClient(bin, { specPath: "ignored", invariant: "TraceComplete", lengthBound: 3 },
  { numTraces: 1 }, compute, { spec });
```

Note: `register_traces` sends `itfTracePaths`, which remain **mirror-local** —
for remote mirrors use `register`, `register_trace_gen`, or the explore flows.

### TCP transport

All client entry points accept either a binary path (spawns the mirror over
stdio, as before) or a `Transport`. `connectMirror` provides a TCP transport;
run the mirror as a daemon with `--serve <port>` (one protocol session per
connection, sequential accept loop):

```ts
// mirror side:  ModelMirrors --serve 8823
import { connectMirror, runClient } from "mirrorecma";

await runClient(connectMirror("192.168.1.10", 8823), apalacheConfig, traceConfig, compute);
// or await startExploreSession(connectMirror("192.168.1.10", 8823), spec, ["Inv"], []);
```

The wire format is the same JSON-lines as stdio. Plain TCP, no TLS — use
SSH/stunnel for untrusted networks.


### `ApalacheConfig`

| Field | Type | Description |
|---|---|---|
| `specPath` | `string` | Path to the .tla file **on the mirror's filesystem** (ignored when inline `spec` is given) |
| `invariant` | `string` | Invariant to violate (Apalache `--inv`) |
| `lengthBound` | `number` | Max Next steps (Apalache `--length`) |
| `initPredicate?` | `string \| null` | Init operator override (`--init`) |
| `nextPredicate?` | `string \| null` | Next operator override (`--next`) |
| `constInit?` | `string \| null` | Constant initialization operator (`--cinit`) |
| `paramVars?` | `string` | Variable to treat as action parameters |

### `TraceGenerationConfig`

| Field | Type | Description |
|---|---|---|
| `numTraces` | `number` | Number of counterexample traces (`--max-error`) |
| `view?` | `string` | State-view operator (`--view`) |

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

Client and mirror exchange newline-delimited JSON, one message per line,
tagged by `proto_step`. The same framing runs over stdio (spawned child) or
TCP (`--serve <port>` daemon + `connectMirror`).

### Message catalog

**Client → Mirror:**

| `proto_step` | Fields | Purpose |
|---|---|---|
| `register` | `apalacheConfig`, `traceConfig`, `spec?` | Generate traces, then replay them against the SUT |
| `register_traces` | `apalacheConfig`, `itfTracePaths` | Replay precomputed ITF traces (paths are mirror-local) |
| `register_trace_gen` | `apalacheConfig`, `traceConfig`, `destPath`, `spec?` | Generate trace files only (no replay) |
| `register_explore` | `spec`, `invariants`, `exports`, `maxSteps` | Mirror-driven symbolic exploration + conformance |
| `register_explore_session` | `spec`, `invariants`, `exports` | Open a client-driven explorer session |
| `report_state` | `state` | SUT's state in response to `initial_state`/`next_step` |
| `explore_assume_transition` | `transitionId` | Session command: prepare transition |
| `explore_next_step` | — | Session command: advance one step |
| `explore_query_state` | — | Session command: read current state |
| `explore_check_invariant` | `invariantId` | Session command: check state invariant |
| `explore_assume_state` | `state` | Session command: constrain current state |
| `explore_rollback` | `snapshotId` | Session command: revert to a snapshot |
| `explore_done` | — | Close the session |

**Mirror → Client:**

| `proto_step` | Fields | Purpose |
|---|---|---|
| `spec_validated` | `result`: `"valid"` \| `{invalid}` | Spec accepted; replay/exploration begins |
| `initial_state` | `action`, `state` | First expected state |
| `next_step` | `action`, `parameters` | Next expected step (explore: full state in `parameters`) |
| `step_ok` | — | Reported state matched |
| `step_mismatch` | `expected`, `actual` | Conformance failure; run aborts |
| `all_steps_done` | — | All traces/steps verified |
| `gen_traces_done` | `itfTracePaths` | Trace files written (paths on the mirror) |
| `explorer_ready` | `initTransitions`, `nextTransitions`, `stateInvariants` | Session opened |
| `explore_transition_status` / `explore_assume_status` | `status`: `ENABLED` \| `DISABLED` \| `UNKNOWN` | Command result |
| `explore_step_done` | `stepNo` | Step advanced |
| `explore_state` | `state` | Current symbolic state |
| `explore_invariant_status` | `status`: `SATISFIED` \| `VIOLATED` \| `UNKNOWN` | Invariant result |
| `explore_rollback_done` | `snapshotId` | Reverted |
| `explore_session_done` | — | Session closed cleanly |
| `register_error` | `error` | Registration failed (bad spec/sources); run ends |
| `protocol_error` | `error` | Protocol violation; in a session, the session **survives** |

`spec` fields have the shape `{ sources: [root, ...deps] }` (TLA+ source
text, root module first — apalache resolves `EXTENDS` across them).

### Flows

Trace replay (`register`, `register_traces`) and mirror-driven explore
(`register_explore`) share the same stepping loop:

```
client                        mirror
  |-- register(...) ------------>|
  |<-- spec_validated -----------|
  |<-- initial_state(action, s) -|
  |-- report_state(s) ---------->|
  |<-- step_ok ------------------|
  |<-- next_step(action, p) -----|
  |-- report_state(s') --------->|
  |          ... repeat ...      |
  |<-- all_steps_done -----------|
```

Generation only (`register_trace_gen`):

```
  |-- register_trace_gen(...) --->|
  |<-- gen_traces_done(paths) ----|
```

Explorer session (`register_explore_session`) — commands and replies
strictly alternate until done:

```
  |-- register_explore_session -->|
  |<-- explorer_ready ------------|
  |-- explore_assume_transition ->|
  |<-- explore_transition_status -|
  |-- explore_next_step --------->|
  |<-- explore_step_done ---------|
  |-- explore_query_state ------->|
  |<-- explore_state -------------|
  |          ... any order ...    |
  |-- explore_done -------------->|
  |<-- explore_session_done ------|
```

### Transports

| Mode | Client side | Mirror side | Notes |
|---|---|---|---|
| stdio | `spawnMirror(binPath)` (implicit when passing a path string) | default (no args) | Local child process |
| TCP | `connectMirror(host, port)` | `ModelMirrors --serve <port>` | One session per connection, sequential accept loop; plain TCP, no TLS |

The message layer is model-checked: `ModelMirros/specs/MirrorProtocol.tla`
defines the legal sequences, and ModelMirros' MBT tests replay spec-generated
protocol traces against the real mirror implementation.

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

> **Update (2026-07-22):** `package.bazel.json` now declares
> `"type": "commonjs"`, matching the actual CJS output of
> `ts_project(module: "node16")`. The workaround below is only needed when
> consuming a Bazel build pinned before that change.

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
