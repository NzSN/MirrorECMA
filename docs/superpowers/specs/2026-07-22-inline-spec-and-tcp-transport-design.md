# Design: Inline Spec Transfer + TCP Transport

**Date:** 2026-07-22
**Status:** approved

## Context

Two related limitations prevent running the mirror and client on different machines:

1. **Spec transfer:** the trace flows (`register`, `register_trace_gen`) send `specPath` — a path on the *mirror's* filesystem. A physically separated mirror cannot read the client's TLA+ files. Multi-module specs (`EXTENDS`/`INSTANCE` dependencies) make this worse: even a local file copy must bring the whole dependency closure. The explore flows already avoid this by sending `spec: {sources: [...]}` inline.
2. **Transport:** the only transport is stdio — the client must spawn the mirror as a child process. No way to talk to a mirror running on another host.

Wire-format facts (verified against ModelMirros `src/Protocol/Format/Json.hs` and apalache's `JsonRpcServer.scala`):

- `ApalacheSpec = { sources: string[] }` — apalache's `loadSpec` treats `sources.head` as the **root module** and `sources.tail` as **dependency modules** (`SourceOption.StringSource(params.sources.head, params.sources.tail)`). EXTENDS is resolved across all provided sources in one parse.
- The apalache CLI, by contrast, resolves `EXTENDS M` by reading `M.tla` from the importing file's directory — so inline sources must be **materialized to files named after their modules** before the trace flows can use them.
- Both sides already speak JSON-lines and have transport abstractions (`Transport` class in Haskell, `Transport` interface in TS).

## Approach

### Feature A — inline spec sources in the trace flows

`register` and `register_trace_gen` gain an **optional** `spec` field (same `{sources: [...]}` shape as explore). When present:

1. The client resolves the dependency closure itself (`specFromFiles`): parse `EXTENDS A, B` / `INSTANCE C` header clauses, resolve `<Name>.tla` relative to the importing file's directory (plus optional search dirs), DFS with a visited set (diamond/cycle safe), skip apalache builtins (`Naturals`, `Integers`, `Reals`, `Sequences`, `FiniteSets`, `TLC`, `Bags`, `Apalache` — provided internally; sending them would shadow). Result: `[root, ...deps]`, root first.
2. The mirror **materializes** the sources: parse each source's `---- MODULE <Name> ----` header (error if absent), write `<tmpdir>/<Name>.tla` (filename must match the module name for EXTENDS resolution), then set `specPath = <tmpdir>/<RootName>.tla` and proceed as today. Temp dir is cleaned up after the run.

Absent `spec` → unchanged filesystem behavior. Wire-compatible: the mirror's decoder defaults a missing `spec` to `Nothing`.

**Deferred:** `register_traces` still sends `itfTracePaths` (also mirror-local). Remote clients use `register`/`register_trace_gen`/explore; paths documented as local-only.

### Feature B — TCP transport

Same JSON-lines framing, mirror-as-server:

- **ModelMirros:** new `Protocol.Transport.Tcp` (`Transport` instance over a connected socket; EOF → empty `ByteString`, same convention as `StdioTransport`). `Main.hs`: no args → stdio (unchanged); `--serve <port>` → listen, **accept loop**: one protocol session (`run`) per connection, `IOException`-guarded so a dropped client doesn't kill the daemon.
- **MirrorECMA:** `connectMirror(host, port): Transport` via `node:net`, same shape as `spawnMirror`. All client entry points' first argument widens from `string` (binPath → spawn stdio) to `string | Transport` — backward compatible.

**Out of scope:** TLS/auth (plain TCP on trusted networks; SSH/stunnel for deployments), Unix domain sockets, concurrent sessions (accept loop is sequential; multiplexing needs protocol-level session ids).

## Changes

### ModelMirros

| File | Action | Responsibility |
|------|--------|----------------|
| `src/Protocol/Core.hs` | Modify | `Maybe ApalacheSpec` on `Register`/`RegisterGenTraces` |
| `src/Protocol/Format/Json.hs` | Modify | `spec` field decode (`.:?`, default `Nothing`) / encode |
| `src/Apalache/SpecSource.hs` | Create | `materializeSpec`: MODULE-header parse, tmpdir write, root path |
| `src/Protocol/Mirror.hs` | Modify | Materialize + override `specPath` in run/gen flows (bracket cleanup) |
| `src/Protocol/Client.hs` | Modify | Thread the `Maybe ApalacheSpec` through `runClient`/`runClientGenTraces` |
| `src/Protocol/Transport/Tcp.hs` | Create | `Transport` over a connected socket |
| `app/Main.hs` | Modify | `--serve <port>` accept loop; stdio default |
| `ModelMirrors.cabal`, `src/BUILD.bazel` | Modify | `network` dep, new modules |
| `test/` | Modify | SpecSource units, 2-module fixture, inline-spec e2e, TCP roundtrip |

### MirrorECMA

| File | Action | Responsibility |
|------|--------|----------------|
| `src/spec.ts` | Create | `specFromFiles(rootPath, searchDirs?)` dependency resolver |
| `src/protocol.ts` | Modify | `spec?: ApalacheSpec` on `Register`/`RegisterTraceGen` |
| `src/client.ts` | Modify | Options object `{ spec? }`; `string \| Transport` first arg |
| `src/transport.ts` | Modify | `connectMirror(host, port)` via `node:net` |
| `src/index.ts` | Modify | Exports |
| `test/` | Modify | Resolver units, inline-spec smoke, TCP smoke |
| `README.md` | Modify | Docs for both features |

## Verification

1. ModelMirros: `cabal build all`, targeted `cabal test` groups, `bazel test //test:ModelMirrors-test`
2. MirrorECMA: `tsc --noEmit`, jest, `MIRROR_BIN=<bin> npx tsx test/smoke.test.ts` (stdio + TCP scenarios), `bazel test //:smoke`
3. Combined remote smoke: mirror `--serve <port>`, all 5 scenarios + inline-spec register over TCP
4. Pin bump in `MODULE.bazel`; commits: ModelMirros `interactive` → merge `main`; MirrorECMA `main`
