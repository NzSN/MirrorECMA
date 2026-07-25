# MirrorECMA

TypeScript client for the [ModelMirros](https://github.com/NzSN/ModelMirrors) protocol — replay TLA+ traces against your state machine implementation over stdio, plain TCP, or mutual TLS, with optional service discovery via a Consul-compatible registry.

## Install & Build

```bash
npm install
npm run build        # → dist/
npm run check        # type-check only
```

## Quick Start

```ts
import { runClient, getParamInt } from "mirrorecma";

const v = (n: number | bigint) => ({ tag: "int", val: BigInt(n) } as const);

await runClient(
  "/path/to/ModelMirros",          // stdio endpoint
  {
    specPath: "specs/Counter.tla",
    invariant: "TraceComplete",
    lengthBound: 5,
    constInit: "CInit",
    paramVars: "parameters",
  },
  { numTraces: 1, view: "View" },
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

## Connecting

All client functions (`runClient`, `runClientWithTraces`, `runClientGenTraces`)
take a `ClientTarget` as their first argument:

```ts
type ClientTarget = string | MirrorEndpoint;

type MirrorEndpoint =
  | { binPath: string }                                   // stdio (same as passing a string)
  | { server: TcpConnectOptions }                         // plain TCP  (ModelMirrors --serve)
  | { server: TlsConnectOptions }                         // mTLS       (ModelMirrors --server --tls)
  | { registry: string; tls: TlsOptions; serviceName? };  // discovery via registry
```

### Stdio (default)

```ts
await runClient("/path/to/ModelMirros", apalacheConfig, traceConfig, compute);
```

### Plain TCP

```ts
await runClient(
  { server: { host: "127.0.0.1", port: 7777 } },
  apalacheConfig, traceConfig, compute
);
```

### Mutual TLS

Start the server with a certificate signed by your private CA (see
`scripts/gen-test-certs.sh` for a throwaway CA, or ModelMirros'
`scripts/gen-certs.sh` for a real one):

```
ModelMirrors --server 7777 --tls \
    --cert server.crt --key server.key --ca ca.crt
```

Then connect with the CA and a client certificate:

```ts
await runClient(
  {
    server: {
      host: "mirror1.example.com",
      port: 7777,
      ca,                 // CA certificate (PEM)
      cert,               // client certificate (PEM)
      key,                // client private key (PEM)
      servername: "mirror1.example.com",  // optional SNI/hostname override
      certSha256: "ab12...",              // optional: pin server cert fingerprint
    },
  },
  apalacheConfig, traceConfig, compute
);
```

TLS 1.3 only. If `certSha256` is given, the peer certificate's SHA-256
fingerprint is checked after the handshake (colon-separated and uppercase
forms accepted); a mismatch throws `FingerprintMismatchError`.

### Service discovery via registry

When the server is started with `--registry <url>` (a Consul-compatible HTTP
API), clients can discover it instead of hardcoding a host:

```ts
await runClient(
  {
    registry: "http://consul:8500",
    tls: { ca, cert, key },   // mTLS credentials; host/port/fingerprint come
                              // from the registry entry
  },
  apalacheConfig, traceConfig, compute
);
```

The client queries `GET <registry>/v1/health/service/modelmirrors?passing=true`
and tries each healthy candidate in turn. The `cert-sha256` service meta (if
present) is pinned automatically. If no candidate is usable, or the registry
is unreachable, the call fails closed — use a direct `server` endpoint as a
fallback. Use `serviceName` to override the default `"modelmirrors"` name.

You can also query a registry directly:

```ts
import { discoverServices } from "mirrorecma";

const services = await discoverServices("http://consul:8500");
// → [{ address: "mirror1.example.com", port: 7777, certSha256: "ab12..." }, ...]
```

## API

### `runClient(target, apalacheConfig, traceConfig, compute)`

Connects to ModelMirros, registers a spec for trace generation, and replays all
traces. Throws on step mismatch or protocol error. Returns when
`all_steps_done` is received.

### `runClientWithTraces(target, apalacheConfig, tracePaths, compute)`

Like `runClient`, but replays pre-generated ITF trace files instead of
generating new ones.

### `runClientGenTraces(target, apalacheConfig, destPath, traceConfig)`

Registers a trace-generation job; the mirror writes ITF traces to `destPath`
(on the machine running the mirror) and returns.

### `connectMirror(target)` → `Promise<Transport>`

Resolves a `ClientTarget` to a connected `Transport` (`send(line)`, async
iteration of received lines, `close()`). Useful for custom protocol drivers.

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
await runClient(bin, apalacheConfig, traceConfig, presetClient(states));
```

### `ApalacheConfig`

| Field | Type | Description |
|---|---|---|
| `specPath` | `string` | Path to the TLA+ spec (on the machine running the mirror) |
| `invariant` | `string` | Invariant to violate (Apalache `--inv`) |
| `lengthBound` | `number` | Max Next steps (Apalache `--length`) |
| `initPredicate?` | `string \| null` | Init predicate override (`--init`) |
| `nextPredicate?` | `string \| null` | Next predicate override (`--next`) |
| `constInit?` | `string \| null` | Constant initialization operator name (`--cinit`) |
| `paramVars?` | `string` | Variable to treat as action parameters |

### `TraceGenerationConfig`

| Field | Type | Description |
|---|---|---|
| `numTraces` | `number` | Number of counterexample traces (`--max-error`) |
| `view?` | `string` | Apalache view operator (`--view`) |

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

The client communicates with the mirror over newline-delimited JSON (stdio,
TCP, or TLS — the session protocol is identical on all transports). Message
types (tagged by `proto_step`):

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

## Testing

```bash
npm test                                # unit tests (protocol, discovery, transports)
MIRROR_BIN=/path/to/ModelMirros npx tsx test/smoke.test.ts   # end-to-end smoke
```

The smoke test exercises stdio, plain TCP, mTLS, and registry discovery
(against a built-in fake Consul). TLS tests need a cabal-built ModelMirros
binary — the Bazel build has no TLS support. Set `MODELMIRRORS_REGISTRY` to a
real Consul URL to additionally verify against a live registry.

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
