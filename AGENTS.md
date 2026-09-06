# AGENTS.md

## Project

ESM TypeScript client for [Mirrors](https://github.com/NzSN/Mirrors), compatible with the ModelMirrors JSONL protocol. Replays TLA+ traces against a state machine. Single-package library, no monorepo. Package manager: **pnpm**.

For generated-adapter onboarding or tutorial changes, read
[`examples/generated-counter/README.md`](examples/generated-counter/README.md).
The primary path is compiled negotiation followed by local trace replay; create
the SUT and generated binding inside the matched registry factory.

## Commands

```bash
pnpm install            # install deps (lockfile is pnpm-lock.yaml)
pnpm run build          # tsc → dist/
pnpm run check          # tsc --noEmit (type-check only)
pnpm run test           # jest (unit + integration, uses --experimental-vm-modules)
pnpm run check:examples # type-check the tutorial and generated binding
MIRRORS_ROOT=<absolute-checkout> pnpm run smoke:generated-counter # tutorial gate
MIRROR_BIN=<path> pnpm run smoke # broad end-to-end smoke test
bazel build //:lib      # TypeScript compile via aspect_rules_ts (ts_project)
bazel test //:smoke     # hermetic smoke test (builds ModelMirros via Bazel)
```

- Tests need `NODE_OPTIONS="--experimental-vm-modules"` — the `test` script handles this.
- The smoke test **hard-fails** (`process.exit(1)`) if `MIRROR_BIN` env var is not set.
- No lint/format scripts configured. Only TypeScript compilation and tests.
- `smoke` runs `test/smoke.test.ts` through the existing ts-node loader. The generated Counter scripts compile to ignored `dist-test/` and run emitted JavaScript; their replay tier needs no live Apalache.
- Bazel builds via `ts_project(transpiler = "tsc")` from `@aspect_rules_ts`, using `tsconfig.bazel.json` (no `rootDir`/`outDir`). Output lands in `bazel-bin/`.

## Architecture

- `src/protocol.ts` — `Value`, `State`, message types, JSON encode/decode (ITF format with `#bigint`/`#tup` markers), value helpers (`asInt`, `asStr`, `asRecord`, `getParam`, `getParamInt`)
- `src/client.ts` — `runClient()` (trace generation), `runClientWithTraces()` (pre-computed traces), `runClientGenTraces()` (generate traces to disk), `runClientExplore()` (mirror-driven symbolic checking), `startExploreSession()`/`ExploreSession` (client-driven explorer sessions), `presetClient()` (pre-defined state sequence)
- `src/spec.ts` — `specFromFiles()`: EXTENDS/INSTANCE dependency-closure resolver producing `{sources: [root, ...deps]}` (root first — apalache treats `sources[0]` as the root module)
- `src/transport.ts` — `spawnMirror()`: spawns a compatible mirror binary over stdio; `connectMirror(host, port)`: TCP transport for a mirror daemon (`ModelMirrors --serve <port>`); `connectTlsMirror(host, port, opts)`: TLS 1.3 mTLS transport for a mirror server (`ModelMirrors --server <port> --tls ...`). All expose the same async-iterable JSON-lines `Transport`
- `src/registry.ts` — `discoverMirrors(registryUrl)`: Consul-compatible `/v1/health/service/modelmirrors` discovery (fail closed to `[]`); `connectMirrorFromRegistry(registryUrl, tls)` connects to the first usable candidate. Parsing + pin-override live here; it knows nothing about the session protocol
- `src/index.ts` — public API barrel, re-exports all symbols
- `examples/generated-counter/` — real Counter, typed port adapter, and negotiated replay/live runner. Reuses the contract, evidence, lock, and compiler-owned output in `test/fixtures/model-interface/counter/`. Its model copy must match `../Mirrors/specs/Counter.tla`; the root client Counter model differs.
- `specs/Counter.tla`, `specs/HourClock.tla`, `specs/ExtMain.tla`+`specs/ExtDep.tla` — TLA+ specs for testing (HourClock: explorer flows; Ext*: multi-module inline-spec flow)
- `specs/traces/` — pre-generated ITF JSON traces
- `test/smoke.test.ts` — self-executing integration test (not a jest suite — it calls `main()` at bottom); covers all flows over stdio, TCP, mTLS (`--server --tls`), and a Consul registry stub. The TLS/registry scenarios are skipped under Bazel (`RUNFILES` set) because the Bazel-pinned ModelMirros commit builds a cabal-only TLS stub
- `test/protocol.test.ts`, `test/spec.test.ts` — jest unit tests

## Key config files

- `tsconfig.json` — npm build (rootDir: `src`, outDir: `dist`, isolatedModules, strict)
- `tsconfig.bazel.json` — Bazel build (no rootDir/outDir, declaration only)
- `package.bazel.json` — Bazel `npm_package` manifest (not the same as `package.json`; main points to `src/index.js`)
- `jest.config.cjs` — CommonJS Jest config (NOT `.ts`). Maps `.js` ESM imports to strip extension via `moduleNameMapper`

## Gotchas

- **ESM**: imports must use `.js` extensions (`import { ... } from "./protocol.js"`). Jest strips these via `moduleNameMapper` in `jest.config.cjs`.
- **Jest config is `.cjs`** — it's CommonJS (`module.exports`), not ESM. There is no `jest.config.ts`.
- **`paramVars`**: for non-deterministic specs, list state variable names to extract as action parameters. Apalache moves them from `stateVars` into step `parameters`. The `report_state` response must OMIT these variables.
- **Value encoding**: ints serialize as `{"#bigint": "42"}` in ITF JSON. Use `encodeState()` (not `encodeClientMessage()`) to put states on the wire — `encodeClientMessage` would double-wrap tag representations by running `JSON.stringify` with the bigint replacer over the already-tagged structure.
- **Bigint**: use `BigInt()` / `0n`, not `number`. JavaScript numbers lose precision beyond `2^53`.
- **Protocol spec**: `../ModelMirros/specs/MirrorProtocol.tla`
- **Node built-ins only for TLS/registry**: `connectTlsMirror` uses `node:tls`, `node:crypto`, `node:net`, `node:fs/promises`; `registry.ts` uses global `fetch`. No npm runtime dependency — the package stays zero-dependency at runtime.
- **TLS 1.3 only**: `connectTlsMirror` pins `minVersion`/`maxVersion` to `"TLSv1.3"`; the server accepts no other version.
- **Fingerprint**: the pin is lowercase hex SHA-256 over the **raw DER** encoding of the server leaf certificate (first cert in the presented chain) — use `sock.getPeerX509Certificate().raw`. Case is normalized, never the DER bytes.
- **`src/protocol.ts` must remain unchanged**: session protocol is transport-independent; mTLS/registry are purely transport-construction concerns.
- **`.js` import extensions apply everywhere**: `registry.ts` imports `./transport.js` (not `./transport`) exactly like the rest of the package.
- **Bazel smoke skips TLS/registry**: the commit pinned in `MODULE.bazel` (9cffb8a) is the newest ModelMirros commit that still has a Bazel build, and it compiles a TLS **stub** that exits "TLS is not available in the Bazel build (cabal-only)". So `//:smoke` runs the stdio + TCP scenarios only (see the `RUNFILES` skip), while the full TLS/registry smoke path runs against a cabal-built binary via `MIRROR_BIN` outside Bazel.
- **Bazel build is ESM**: `ts_project(transpiler = "tsc")` emits ESM (`module: "node16"` under the execroot's `type: "module"` package.json), and `package.bazel.json` declares `"type": "module"` to match — the Bazel build and `//:smoke` are self-consistent. README "Known Issues" documents the history and the legacy consuming workaround for pinned builds.
- **Smoke tests are standalone**: `test/smoke.test.ts`, `test/model-interface-counter.smoke.ts`, and `test/generated-counter.smoke.ts` run through their package scripts, outside Jest. The generated tutorial gate checks model provenance and compiler freshness as well as correct/faulty replay.
- **Smoke test RUNFILES**: when run under Bazel, the `RUNFILES` env var is used to resolve `MIRROR_BIN` and trace paths.
