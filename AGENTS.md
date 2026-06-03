# AGENTS.md

## Project

ESM TypeScript client for the [ModelMirros](https://github.com/NzSN/ModelMirrors) protocol — replays TLA+ traces against a state machine over stdio. Single-package library, no monorepo.

## Commands

```bash
npm run build       # tsc → dist/
npm run check       # tsc --noEmit (type-check only)
npm run test        # jest (unit + integration, requires --experimental-vm-modules)
npm run smoke -- <path-to-ModelMirros-binary>   # integration test, needs built binary
bazel build //:lib  # TypeScript compile via Bazel (genrule → tsc)
```

- Tests need `NODE_OPTIONS="--experimental-vm-modules"` — the `test` script handles this.
- The smoke test auto-skips if `MIRROR_BIN` env var is not set.
- No lint/format scripts configured. Only TypeScript compilation and tests.
- Bazel requires `node_modules/` present (run `npm install` first). The genrule calls `tsc` from the workspace's `node_modules/` via `--local --no-sandbox`. Outputs to `bazel-bin/`.

## Architecture

- `src/protocol.ts` — value types, message types, JSON encode/decode (ITF format with `#bigint`/`#tup` markers)
- `src/client.ts` — `runClient()`: the main client loop; `presetClient()`: pre-defined state sequence
- `src/transport.ts` — `spawnMirror()`: spawns the Haskell binary over stdio, exposes async iterable
- `specs/` — TLA+ specs for smoke testing
- `test/smoke.test.ts` — end-to-end integration test against a live ModelMirros binary

## Gotchas

- **ESM**: imports must use `.js` extensions (`import { ... } from "./protocol.js"`). Jest maps these via `moduleNameMapper` in `jest.config.ts`.
- **`paramVars`**: for non-deterministic specs, list state variable names to extract as action parameters. Apalache moves them from `stateVars` into step `parameters`. The `report_state` response must OMIT these variables.
- **Value encoding**: ints serialize as `{"#bigint": "42"}`. The default fallback is the deprecated pattern where `TagVal` wrappers are inlined directly. This was adopted by the tests but is deprecated in favor of the specification.
- **Bigint**: use `BigInt()` / `0n`, not `number`. JavaScript numbers lose precision beyond `2^53`.
- **Protocol spec**: `../ModelMirros/specs/MirrorProtocol.tla`

## Project structure

```
src/            # TypeScript source (rootDir)
dist/           # tsc output (outDir), gitignored
test/           # jest tests (*.test.ts)
specs/          # TLA+ spec files
scripts/smoke   # helper to run smoke test
```
