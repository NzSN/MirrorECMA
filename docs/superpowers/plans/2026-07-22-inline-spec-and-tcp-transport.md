# Inline Spec Transfer + TCP Transport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mirror↔client work across machines: (A) TLA+ sources (with dependency closure) travel inline in `register`/`register_trace_gen`; (B) JSON-lines over TCP transport alongside stdio.

**Architecture:** Design doc: `docs/superpowers/specs/2026-07-22-inline-spec-and-tcp-transport-design.md`. Root module = `sources[0]` (apalache `sources.head` rule). Mirror materializes inline sources to `<tmpdir>/<ModuleName>.tla` for the CLI flows.

**Tech Stack:** Haskell (ModelMirros, GHC2024, explicit imports), TypeScript ESM (MirrorECMA), jest/tsx/tasty, Bazel.

---

## Feature A — Inline spec sources

### Task A1: Protocol.Core + JSON codecs (ModelMirros)

**Files:** `src/Protocol/Core.hs`, `src/Protocol/Format/Json.hs`, `src/Protocol/Client.hs`

- [ ] **Step 1:** Add `Maybe ApalacheSpec` to `Register` and `RegisterGenTraces` constructors:

```haskell
| Register !ApalacheConfig !TraceGenerationConfig !(Maybe ApalacheSpec)
| RegisterGenTraces !ApalacheConfig !TraceGenerationConfig !(Maybe FilePath) !(Maybe ApalacheSpec)
```

- [ ] **Step 2:** JSON: encode `"spec" .= mSpec` in both `toJSON` cases; decode with `o .:? "spec"` (defaults `Nothing`). All other message cases unchanged.
- [ ] **Step 3:** `Protocol.Client`: `runClient`/`runClientGenTraces` send `Nothing` (existing behavior); add `runClientWithSpec`/`runClientGenTracesWithSpec` variants that take `ApalacheSpec` (used by tests; keeps old signatures stable).

### Task A2: Apalache.SpecSource (ModelMirros)

**Files:** Create `src/Apalache/SpecSource.hs`

- [ ] **Step 1: `moduleName` parser.** Extract `<Name>` from the `---- MODULE <Name> ----` header line (dashes optional in count, name is the token between `MODULE` and the trailing dashes). `Left` on missing header.

```haskell
moduleName :: Text -> Either Text Text
```

- [ ] **Step 2: `materializeSpec`.**

```haskell
materializeSpec :: ApalacheSpec -> IO (Either Text (FilePath, FilePath))
```

- `sources` must be non-empty; parse each source's module name
- fresh dir: `getTemporaryDirectory` + `createDirectoryIfMissing True` with unique suffix (`modelmirrors-spec-<pid>-<n>` from an atomic counter / `getProcessID`)
- write each source to `<dir>/<Name>.tla` (collision = two modules with the same name → `Left`)
- return `(dir, dir </> <rootName>.tla)` where root is `head sources`
- Caller wraps in `bracket`/`finally` with `removeDirectoryRecursive`.

### Task A3: Protocol.Mirror integration (ModelMirrors)

**Files:** `src/Protocol/Mirror.hs`

- [ ] **Step 1:** `MirrorRecvRegister`/`MirrorRecvRegisterGenTraces` `MirrorStep` constructors carry the `Maybe ApalacheSpec` too (keeps `Eq` honest for tests; `mirrorStepActionName`/`normalizeMirrorSteps` unchanged — no MBT impact).
- [ ] **Step 2:** In `MkRunMirror`/`MkRunMirrorGenTraces` `exec`:

```haskell
withSpecDir mSpec $ \cfg' -> generateTraces cfg' tc   -- cfg' = cfg{specPath = rootPath} when Just
```

where `withSpecDir Nothing k = k cfg` and `withSpecDir (Just s) k = materializeSpec s >>= either (send RegisterError) (\(d,p) -> bracket_ cleanup (k cfg{specPath = p}))`.

- [ ] **Step 3:** `runMirror`/`runMirrorGenTraces` wrappers gain the `Maybe ApalacheSpec` parameter; `runMirrorWithTraces` untouched.

### Task A4: ModelMirros tests

**Files:** `test/Apalache/SpecSourceSpec.hs` (new), `test/specs/ExtDep.tla` + `test/specs/ExtMain.tla` (new), `test/MirrorE2ESpec.hs`, `test/Main.hs`, `ModelMirrors.cabal`, `test/BUILD.bazel` (glob — no change)

- [ ] **Step 1: Units** — `moduleName` on valid/garbage headers; `materializeSpec` writes correctly named files, rejects empty sources, rejects duplicate module names, rejects missing header.
- [ ] **Step 2: Fixture** — `ExtDep.tla` defines `DepInit == x = 0`, `ExtMain.tla` does `EXTENDS Integers, ExtDep` with its own `Init`/`Next`/`TraceComplete` (deterministic, constant-free, short bound).
- [ ] **Step 3: E2E** — MockTransport: send `Register` with `specPath = "/nonexistent/ExtMain.tla"` **and** `Just spec` (both sources read from `test/specs/`); expect success — proves the mirror never touches `specPath` when inline sources are present. Add to `MirrorE2ESpec`.

### Task A5: MirrorECMA resolver

**Files:** Create `src/spec.ts`

- [ ] **Step 1: `specFromFiles`.**

```ts
export async function specFromFiles(rootPath: string, searchDirs: string[] = []): Promise<ApalacheSpec>
```

- regex per file: `/^\s*EXTENDS\s+(.+)$/m` and `/^\s*INSTANCE\s+(.+)$/m`; split on commas; `INSTANCE` may have `WITH ...` — take the module name token only
- skip builtins: `Naturals Integers Reals Sequences FiniteSets TLC Bags Apalache`
- resolve `<Name>.tla` in importer's dir, then `searchDirs`; missing → throw `Error("module <Name> required by <importer> not found")`
- DFS post-order with visited set → deps deduped, root first in result: `{ sources: [rootText, ...depTexts] }`
- cycle between user modules: visited set prevents infinite recursion (TLA+ forbids circular EXTENDS anyway; apalache will reject the result — surface that, don't pre-validate)

### Task A6: MirrorECMA protocol + client API

**Files:** `src/protocol.ts`, `src/client.ts`, `src/index.ts`

- [ ] **Step 1:** `Register`/`RegisterTraceGen` interfaces gain `spec?: ApalacheSpec`.
- [ ] **Step 2:** `runClient`/`runClientGenTraces` trailing options object:

```ts
export interface RunOptions { spec?: ApalacheSpec }
runClient(target, apalacheConfig, config, compute, opts: RunOptions = {})
```

Include `spec` in the encoded message when present (JSON `undefined` fields are dropped automatically — mirror treats absent as `Nothing`).

- [ ] **Step 3:** Export `specFromFiles`, `RunOptions` from `index.ts`.

### Task A7: MirrorECMA tests

**Files:** `test/spec.test.ts` (new), `test/protocol.test.ts`, `test/smoke.test.ts`, `specs/ExtDep.tla` + `specs/ExtMain.tla` (new, copy of ModelMirros fixtures)

- [ ] **Step 1: Resolver units** — transitive closure, diamond dedupe, missing dep error message, builtin skip, root-first ordering.
- [ ] **Step 2: Codec** — `register` with `spec` round-trips through `encodeClientMessage` with sources intact.
- [ ] **Step 3: Smoke** — `testRegisterInlineSpec()`: `specFromFiles("./specs/ExtMain.tla")`, `runClient(BIN, {specPath: "/nonexistent/ExtMain.tla", ...}, traceConfig, computer, {spec})` → resolves.

---

## Feature B — TCP transport

### Task B8: Protocol.Transport.Tcp (ModelMirros)

**Files:** Create `src/Protocol/Transport/Tcp.hs`; modify `ModelMirrors.cabal`, `src/BUILD.bazel`

- [ ] **Step 1:** `TcpTransport` wrapping a connected `Socket` + `Handle`:

```haskell
data TcpTransport = TcpTransport Handle
tcpTransport :: Socket -> IO TcpTransport   -- socketToHandle ReadWriteMode, NoBuffering... LineBuffering
```

`recv` = `B8.hGetLine` mapped to `B8.empty` on EOF/`IOException` (StdioTransport convention); `send` = `B8.hPutStrLn` + `hFlush`.

- [ ] **Step 2:** `network` dep: cabal `build-depends: network >= 3.1`, Bazel `@stackage//:network`.

### Task B9: --serve accept loop (ModelMirros)

**Files:** `app/Main.hs`, `test/Apalache/TcpTransportSpec.hs` (new, or extend an existing spec module)

- [ ] **Step 1: Main.**

```haskell
main = getArgs >>= \case
  ["--serve", portStr] -> serve (read portStr)
  _                    -> run StdioTransport >> pure ()

serve port = withSocketsDo $ bracket (listenOn port) close $ \lsock -> forever $ do
  (conn, _) <- accept lsock
  t <- tcpTransport conn
  try (run t) >>= \case
    Left (e :: IOException) -> hPrint stderr e   -- client dropped; keep serving
    Right _ -> pure ()
  close conn
```

- [ ] **Step 2: Tests** — loopback roundtrip: fork `listen`/accept, connect a client socket, exchange `sendMsg`/`recvMsg` both directions incl. `#bigint` payloads; disconnect mid-session → accept loop survives (assert second connection works).

### Task B10: connectMirror (MirrorECMA)

**Files:** `src/transport.ts`

- [ ] **Step 1:**

```ts
export function connectMirror(host: string, port: number): Transport & { ready: Promise<void> }
```

`net.createConnection`, same readline line-split buffer/waiter pattern as `spawnMirror`; `close()` ends + destroys the socket; expose `ready` (resolves on `connect`, rejects on `error`) so callers can await listen-readiness.

### Task B11: string | Transport entry points (MirrorECMA)

**Files:** `src/client.ts`, `src/index.ts`

- [ ] **Step 1:** First arg of `runClient`, `runClientWithTraces`, `runClientGenTraces`, `runClientExplore`, `startExploreSession` widens to `string | Transport`:

```ts
function resolveTransport(t: string | Transport): Transport {
  return typeof t === "string" ? spawnMirror(t) : t;
}
```

- [ ] **Step 2:** Export `connectMirror` from `index.ts`.

### Task B12: TCP smoke (MirrorECMA)

**Files:** `test/smoke.test.ts`

- [ ] **Step 1:** `withServedMirror(fn)`: spawn `BIN --serve <port>` (port 0 → parse actual? simpler: pick a high port + retry), poll `connectMirror` until `ready`, run `fn(transport)`, kill child.
- [ ] **Step 2:** Run the 5 existing scenarios + inline-spec register over the TCP transport. stdio scenarios stay as-is (both transports covered).

---

## Docs, verification, release

- [ ] **README.md** — "Inline spec sources" + "TCP transport" sections; document `register_traces` paths as local-only.
- [ ] **AGENTS.md** (MirrorECMA) — transport note; **AGENTS.md** (ModelMirros) — `network` dep, `--serve` flag, new modules.
- [ ] ModelMirros: `cabal build all`; `cabal run ModelMirrors-test -- -p '/SpecSourceSpec|MirrorE2ESpec|TcpTransportSpec/'`; `bazel test //test:ModelMirrors-test`
- [ ] MirrorECMA: `tsc --noEmit`; jest; `MIRROR_BIN=<bin> npx tsx test/smoke.test.ts`; `bazel test //:smoke`
- [ ] Commit ModelMirros (`interactive`), merge to `main`, push; bump MirrorECMA `MODULE.bazel` pin to the merge commit; commit MirrorECMA (`main`).
