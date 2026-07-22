# AGENTS.md

## Project

ESM TypeScript client for the [ModelMirros](https://github.com/NzSN/ModelMirrors) protocol — replays TLA+ traces against a state machine over stdio. Single-package library, no monorepo. Package manager: **pnpm**.

## Commands

```bash
pnpm install            # install deps (lockfile is pnpm-lock.yaml)
pnpm run build          # tsc → dist/
pnpm run check          # tsc --noEmit (type-check only)
pnpm run test           # jest (unit + integration, uses --experimental-vm-modules)
MIRROR_BIN=<path> npx tsx test/smoke.test.ts   # end-to-end smoke test
bazel build //:lib      # TypeScript compile via aspect_rules_ts (ts_project)
bazel test //:smoke     # hermetic smoke test (builds ModelMirros via Bazel)
```

- Tests need `NODE_OPTIONS="--experimental-vm-modules"` — the `test` script handles this.
- The smoke test **hard-fails** (`process.exit(1)`) if `MIRROR_BIN` env var is not set.
- No lint/format scripts configured. Only TypeScript compilation and tests.
- `package.json` script `"smoke"` references `scripts/smoke.ts` which does **not exist** — use `npx tsx test/smoke.test.ts` directly.
- Bazel builds via `ts_project(transpiler = "tsc")` from `@aspect_rules_ts`, using `tsconfig.bazel.json` (no `rootDir`/`outDir`). Output lands in `bazel-bin/`.

## Architecture

- `src/protocol.ts` — `Value`, `State`, message types, JSON encode/decode (ITF format with `#bigint`/`#tup` markers), value helpers (`asInt`, `asStr`, `asRecord`, `getParam`, `getParamInt`)
- `src/client.ts` — `runClient()` (trace generation), `runClientWithTraces()` (pre-computed traces), `runClientGenTraces()` (generate traces to disk), `runClientExplore()` (mirror-driven symbolic checking), `startExploreSession()`/`ExploreSession` (client-driven explorer sessions), `presetClient()` (pre-defined state sequence)
- `src/spec.ts` — `specFromFiles()`: EXTENDS/INSTANCE dependency-closure resolver producing `{sources: [root, ...deps]}` (root first — apalache treats `sources[0]` as the root module)
- `src/transport.ts` — `spawnMirror()`: spawns the Haskell binary over stdio; `connectMirror(host, port)`: TCP transport for a mirror daemon (`ModelMirrors --serve <port>`). Both expose the same async-iterable JSON-lines `Transport`
- `src/index.ts` — public API barrel, re-exports all symbols
- `specs/Counter.tla`, `specs/HourClock.tla`, `specs/ExtMain.tla`+`specs/ExtDep.tla` — TLA+ specs for testing (HourClock: explorer flows; Ext*: multi-module inline-spec flow)
- `specs/traces/` — pre-generated ITF JSON traces
- `test/smoke.test.ts` — self-executing integration test (not a jest suite — it calls `main()` at bottom); covers all flows over stdio AND over TCP
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
- **Bazel CJS output mismatch**: Bazel's `ts_project(transpiler = "tsc")` produces CJS output, but `package.bazel.json` declares `"type": "module"`. See README "Known Issues" for consuming workaround.
- **Smoke test is standalone**: `test/smoke.test.ts` is NOT a jest suite — it calls `main()` at the bottom and uses `process.exit()`. Run it directly with `tsx`.
- **Smoke test RUNFILES**: when run under Bazel, the `RUNFILES` env var is used to resolve `MIRROR_BIN` and trace paths.
