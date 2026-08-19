# ModelMirrors Server-Mode Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Claude Code assignment:** every task below is assigned to **Claude Code**. Run the tasks in dependency order. Tasks T1–T3 (transport core) and T4 (registry) can be prepared in parallel sessions **only if** the `connectTlsMirror`/`TlsOptions`/`TlsConnectTransport` interface from T2 is written first and not modified afterward; do not have two Claude Code sessions editing `src/index.ts` concurrently. The safe default is one sequential Claude Code run.

**Goal:** Give MirrorECMA client-side support for ModelMirrors server mode: direct mTLS transport plus Consul service-registry discovery, without changing the session protocol.

**Architecture:** Design doc: `docs/server-mode-support.md`. Server mode is TLS 1.3 mTLS over TCP + optional Consul registry; JSON-lines `Register*` protocol is unchanged. MirrorECMA adds `connectTlsMirror`, `discoverMirrors`, and `connectMirrorFromRegistry` behind the existing `Transport` interface.

**Tech Stack:** TypeScript ESM (`node16`, `.js` import extensions for relative imports), Node built-ins only (`node:tls`, `node:crypto`, `node:net`, `node:readline`, `node:fs/promises`, global `fetch`), jest, tsx smoke runner, Bazel (`ts_project`, `js_test`).

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/transport.ts` | Modify | `TlsOptions`, `TlsConnectTransport`, `connectTlsMirror`, pin/key helpers |
| `src/registry.ts` | Create | `MirrorServiceInfo`, `discoverMirrors`, `connectMirrorFromRegistry` |
| `src/client.ts` | Modify | Async `resolveTransport`; await optional `ready` in all entry points |
| `src/index.ts` | Modify | Export new transport + registry API |
| `src/protocol.ts` | **No change** | Session protocol is transport-independent |
| `src/spec.ts` | **No change** | Inline specs already support remote trace flows |
| `package.json` / lockfiles | **No change** | No new npm dependencies |
| `MODULE.bazel` | Modify | Bump `modelmirrors` `git_override` to a server-mode commit; refresh lock |
| `test/registry.test.ts` | Create | Consul response parsing/discovery unit tests |
| `test/smoke.test.ts` | Modify | TLS smoke for all flows + negative mTLS + registry stub failover |
| `README.md` | Modify | Server mode section + transport table |
| `AGENTS.md` | Modify | New modules/API notes and gotchas |

---

## Task Assignment Summary

| Task | Assignee | Content | Depends on |
|------|----------|---------|------------|
| T1 | Claude Code | Upstream pin verification + `MODULE.bazel` bump | — |
| T2 | Claude Code | `connectTlsMirror` in `src/transport.ts` | T1 (build baseline) |
| T3 | Claude Code | Await optional `ready` in client + exports | T2 |
| T4 | Claude Code | Registry discovery in `src/registry.ts` | T2 interface (T3 for exports) |
| T5 | Claude Code | Unit tests for TLS helpers + registry parser | T2, T4 |
| T6 | Claude Code | TLS/registry smoke + negative integration tests | T2, T3, T4 |
| T7 | Claude Code | Docs, Bazel verification, final commit | T1–T6 |

---

## Task T1: Upstream pin verification + MODULE.bazel bump

**Files:**
- Modify: `MODULE.bazel` (and `MODULE.bazel.lock` as regenerated)

**Assignee:** Claude Code

- [ ] **Step 1:** Confirm ModelMirros main contains server mode (`app/Main.hs` parses `--server ... --tls`, `src-tls/Protocol/Transport/Tls.hs` exists).

```bash
git -C ../ModelMirros rev-parse origin/main
git -C ../ModelMirros show --stat origin/main -- app/Main.hs src-tls/Protocol/Transport/Tls.hs
```

- [ ] **Step 2:** In `MODULE.bazel`, replace the `modelmirrors` `commit` with the verified server-mode commit (local reference: `4441c25`; use the actual `origin/main` hash you just verified):

```python
bazel_dep(name = "modelmirrors", version = "0.1.0.0")
git_override(
    module_name = "modelmirrors",
    remote = "https://github.com/NzSN/ModelMirrors",
    commit = "<verified-server-mode-commit>",
)
```

- [ ] **Step 3:** Refresh and build:

```bash
bazel fetch //... 2>&1
bazel build //:lib 2>&1
```

Expected: extension resolves (the ModelMirrors stack snapshot includes the TLS deps) and `lib_src` still compiles. If `MODULE.bazel.lock` changes, commit it.

- [ ] **Step 4:** Run the existing smoke baseline (still uses stdio + legacy TCP only):

```bash
bazel test //:smoke --test_output=errors 2>&1
```

Expected: PASSED. This is the regression baseline before client changes.

---

## Task T2: `connectTlsMirror` in `src/transport.ts`

**Files:**
- Modify: `src/transport.ts`

**Assignee:** Claude Code

### T2 Step 1: Imports and types

Add imports:

```ts
import * as tls from "node:tls";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
```

Add the public types from the design doc:

```ts
export interface TlsOptions {
  caPath: string;
  certPath: string;
  keyPath: string;
  pin?: string;
  servername?: string;
  handshakeTimeoutMs?: number;
}

export interface TlsConnectTransport extends Transport {
  readonly peerFingerprint: string;
}
```

### T2 Step 2: Private helpers in `transport.ts`

- [ ] `normalizeFingerprint(pin: string): string` — trim, lowercase, validate `/^[0-9a-f]{64}$/`, throw `Error("invalid certificate fingerprint: ...")` on mismatch.
- [ ] `sha256Hex(buf: Uint8Array): string` — `createHash("sha256").update(buf).digest("hex")`.
- [ ] `assertPrivateKeyMode(keyPath: string): Promise<void>` — skip on `process.platform === "win32"`; otherwise `stat(keyPath)` and require `(mode & 0o077) === 0`, throwing `Error("client key <path> must not be accessible by group/other (chmod 0600)")` otherwise.
- [ ] `awaitSecureConnect(sock, timeoutMs): Promise<tls.TLSSocket>` — promise over `secureConnect` and `error`; clear the timer on both paths; timeout destroys the socket with `Error("TLS handshake timed out after <n>ms")`. On `secureConnect`, check `sock.authorized`; if false, destroy the socket and reject with `sock.authorizationError` (defense for Node versions that emit `secureConnect` before rejecting an unauthorized peer).
- [ ] `peerLeafFingerprint(sock): string` — `sock.getPeerX509Certificate()` (fallback `sock.getPeerCertificate().raw`), throw if no certificate, return `sha256Hex(cert.raw)`.

### T2 Step 3: `connectTlsMirror`

```ts
export async function connectTlsMirror(
  host: string,
  port: number,
  opts: TlsOptions,
): Promise<TlsConnectTransport> {
  await assertPrivateKeyMode(opts.keyPath);
  const [ca, cert, key] = await Promise.all([
    readFile(opts.caPath),
    readFile(opts.certPath),
    readFile(opts.keyPath),
  ]);
  const expectedPin = opts.pin ? normalizeFingerprint(opts.pin) : undefined;

  const sock = tls.connect({
    host,
    port,
    servername: opts.servername ?? host,
    ca,
    cert,
    key,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    rejectUnauthorized: true,
  });

  await awaitSecureConnect(sock, opts.handshakeTimeoutMs ?? 10_000);
  const peerFingerprint = peerLeafFingerprint(sock);
  if (expectedPin && peerFingerprint !== expectedPin) {
    sock.destroy();
    throw new Error(
      `certificate fingerprint mismatch for ${host}:${port}: expected ${expectedPin}, got ${peerFingerprint}`,
    );
  }

  // The mirror sends nothing until Register*, so framing can be attached now.
  const it = lineIterator();
  const rl = createInterface({ input: sock, crlfDelay: Infinity });
  sock.on("error", () => {});       // post-handshake errors surface as iterator close
  rl.on("error", () => {});
  rl.on("line", it.emit);
  rl.on("close", it.finish);
  sock.on("close", it.finish);

  return {
    peerFingerprint,
    send(line: string) { sock.write(line + "\n"); },
    async close(): Promise<number> {
      if (sock.destroyed) return 0;
      const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
      sock.end();
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1_000))]);
      if (!sock.destroyed) sock.destroy();
      return 0;
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return { next: it.pull };
    },
  };
}
```

Notes:
- `rejectUnauthorized: true` gives CA + hostname/SAN validation; `minVersion`/`maxVersion` enforce TLS 1.3 only.
- Node presents `cert`/`key` automatically when the server sends `CertificateRequest`.
- Keep `lineIterator` private in `transport.ts`; no extraction needed for this feature.

### T2 Step 4: Compile gate

```bash
pnpm run check
```

Expected: no TypeScript errors.

---

## Task T3: Client `ready` hardening + exports

**Files:**
- Modify: `src/client.ts`, `src/index.ts`

**Assignee:** Claude Code

- [ ] **Step 1:** Change `resolveTransport` to async and await optional `ready`:

```ts
type MaybeReadyTransport = Transport & { ready?: Promise<void> };

async function resolveTransport(target: string | Transport): Promise<Transport> {
  const t = typeof target === "string" ? spawnMirror(target) : target;
  const maybeReady = t as MaybeReadyTransport;
  if (maybeReady.ready) await maybeReady.ready;
  return t;
}
```

- [ ] **Step 2:** Update all call sites to `const t = await resolveTransport(target);`:
  - `runClient`
  - `runClientWithTraces`
  - `runClientGenTraces`
  - `runClientExplore`
  - `ExploreSession.open`

Signatures do not change. `startExploreSession` delegates to `ExploreSession.open` and needs no signature change.

- [ ] **Step 3:** In `src/index.ts`, export from `transport.js`:

```ts
export {
  spawnMirror,
  connectMirror,
  connectTlsMirror,
  type Transport,
  type ConnectTransport,
  type TlsOptions,
  type TlsConnectTransport,
} from "./transport.js";
```

Registry exports are added in T4; keep this step compiling by not referencing them yet.

- [ ] **Step 4:** Gate:

```bash
pnpm run check
pnpm run test
```

Expected: existing unit tests green; existing smoke behavior unchanged.

---

## Task T4: Registry discovery in `src/registry.ts`

**Files:**
- Create: `src/registry.ts`
- Modify: `src/index.ts`

**Assignee:** Claude Code

### T4 Step 1: Types and URL helper

```ts
import {
  connectTlsMirror,
  type TlsConnectTransport,
  type TlsOptions,
} from "./transport.js";

export interface MirrorServiceInfo {
  id: string;
  host: string;
  port: number;
  certSha256?: string;
}

export interface RegistryOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface RegistryConnectOptions extends RegistryOptions {
  pin?: string;
}
```

`registryEndpoint(base: string | URL, path: string): URL` must normalize a missing trailing slash on the base before resolving a relative path (do **not** let a leading `/` in the path discard a registry prefix path).

### T4 Step 2: `discoverMirrors`

```ts
export async function discoverMirrors(
  registryUrl: string | URL,
  opts: RegistryOptions = {},
): Promise<MirrorServiceInfo[]> { ... }
```

- Endpoint: `registryEndpoint(registryUrl, "v1/health/service/modelmirrors?passing=true")`.
- HTTP: `fetch` (injectable via `opts.fetch`), `Accept: application/json`, `signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000)`.
- Fail closed: any throw, non-2xx response, JSON parse error, or non-array top level returns `[]` (do not throw).
- Parse each array element with a total helper (export as `parseServiceEntry` from `src/registry.ts` for direct unit testing, but do **not** re-export from `src/index.ts`):
  - `Service` must be an object.
  - `Service.Address` non-empty string after trim.
  - `Service.Port` finite safe integer in `1..65535`.
  - `Service.Meta["cert-sha256"]`, when present, must match `/^[0-9a-fA-F]{64}$/`; normalize to lowercase. Malformed present value → skip the entry (no unpinned fallback).
  - `Service.ID` defaults to `""` if missing (not used by connect logic).
- Preserve registry order; do not deduplicate.

### T4 Step 3: `connectMirrorFromRegistry`

```ts
export async function connectMirrorFromRegistry(
  registryUrl: string | URL,
  tls: TlsOptions,
  opts: RegistryConnectOptions = {},
): Promise<TlsConnectTransport> { ... }
```

1. `const services = await discoverMirrors(registryUrl, opts);`
2. If empty → `throw new Error("no mirror candidates discovered from <url>")`.
3. For each service in order:
   - `const pin = opts.pin ?? service.certSha256;`
   - `return await connectTlsMirror(service.host, service.port, { ...tls, pin });`
   - Catch per-candidate errors and append `"<host>:<port>: <message>"` to a `failures` array.
4. If all fail → `throw new Error("no usable mirror discovered from <url>: " + failures.join("; "))`.

### T4 Step 4: Export from `src/index.ts`

```ts
export {
  discoverMirrors,
  connectMirrorFromRegistry,
  type MirrorServiceInfo,
  type RegistryOptions,
  type RegistryConnectOptions,
} from "./registry.js";
```

### T4 Step 5: Gate

```bash
pnpm run check
pnpm run test
```

---

## Task T5: Unit tests

**Files:**
- Create: `test/registry.test.ts`
- Modify: `test/protocol.test.ts` (only if a fingerprint/transport helper test fits naturally)

**Assignee:** Claude Code

- [ ] **Step 1: Registry parser tests** (`test/registry.test.ts`, import `parseServiceEntry` and `discoverMirrors` directly from `../src/registry.js`):
  - Valid entry: `{ Service: { ID, Address: "10.0.0.5", Port: 8999, Meta: { "cert-sha256": "<64 hex>" } } }` → host/port/certSha256 lowercased.
  - Missing `Meta` → `certSha256` undefined.
  - Missing/empty `Address` → skipped.
  - Missing/zero/negative/`>65535`/non-integer `Port` → skipped.
  - Malformed `cert-sha256` (short, non-hex) → skipped.
  - Non-array / malformed JSON top level → `discoverMirrors` resolves `[]`.
  - Non-2xx response → `discoverMirrors` resolves `[]`.
  - Injected `fetch` is called with the expected URL (`.../v1/health/service/modelmirrors?passing=true`) and an `Accept: application/json` header.
  - Base URL with and without trailing slash produce the same endpoint.

- [ ] **Step 2: Fingerprint helper tests** (direct import from `../src/transport.js`; export the small pure helpers from `transport.ts` if needed, or test via a generated cert):
  - Lowercase normalization and 64-hex validation.
  - SHA-256 over a known DER byte fixture matches a precomputed digest (compute the fixture digest with `node:crypto` in the test, or use `openssl` output).

- [ ] **Step 3:** Run:

```bash
pnpm run test
```

---

## Task T6: TLS + registry smoke and negative integration tests

**Files:**
- Modify: `test/smoke.test.ts` (keep it a standalone `main()` script, not a Jest suite)
- Create if useful: `test/tls-certs.ts` (then add it to `smoke_test` srcs in `BUILD.bazel`; otherwise keep helpers in `test/smoke.test.ts`)

**Assignee:** Claude Code

### T6 Step 1: Cert fixture helper

- Generate throwaway certs into a temp dir with `openssl` (available on PATH; smoke is already `local`/`no-sandbox`):
  - `ca.key`/`ca.crt` (self-signed CA)
  - `server.key`/`server.crt` with `subjectAltName=IP:127.0.0.1`, signed by the CA
  - `client.key`/`client.crt` with `extendedKeyUsage=clientAuth`, signed by the CA
  - `rogue-ca.crt` + `rogue-client.key`/`rogue-client.crt` signed by rogue CA (negative test)
- `chmod 600` all private keys (the client enforces it).
- Do not commit generated certs.

### T6 Step 2: `testOverTls()`

- Spawn:

```ts
spawn(BIN, ["--server", String(port), "--tls",
  "--cert", serverCrt, "--key", serverKey, "--ca", caCrt], { stdio: ["ignore", "inherit", "inherit"] });
```

- Poll with `connectTlsMirror("127.0.0.1", port, clientTls)` until it resolves (same retry pattern as `testOverTcp`).
- Run **every existing scenario** over TLS: `testRegister`, `testRegisterTraces`, `testRegisterGenTraces`, `testExplore`, `testExploreSession`, `testRegisterInlineSpec`.
- `tlsTarget(port, certs)` returns `connectTlsMirror(...)` (an async factory), so adjust the scenario helpers or wrap `await` where the target is passed.

### T6 Step 3: Negative mTLS tests

- Wrong CA client (rogue cert) → `connectTlsMirror` rejects.
- Client cert signed by a different CA → `connectTlsMirror` rejects.
- Direct pin mismatch (set `pin` to 64 zeros) → `connectTlsMirror` rejects.
- Key file mode `0644` → `connectTlsMirror` rejects on POSIX with the `0600` error.

### T6 Step 4: Registry stub + failover test

- Start a small `node:http` server returning a canned Consul health response.
- Compute the real server fingerprint from `server.crt` with the same SHA-256-over-DER helper.
- Positive: `connectMirrorFromRegistry(stubUrl, clientTls)` resolves and completes `testRegister` over the returned transport.
- Failover: stub returns two entries — first `Address/Port` points at the real server but advertises a wrong `cert-sha256`; second is correct. Assert the helper connects to the second candidate (e.g. instrument order or simply assert the returned session succeeds and the first entry would have failed pin check).
- Fail-closed: stub returns malformed JSON; expect "no mirror candidates discovered".
- Empty array; expect "no mirror candidates discovered".

### T6 Step 5: Smoke gate

```bash
MIRROR_BIN=<ModelMirrors binary> npx tsx test/smoke.test.ts
```

Expected: stdio, legacy TCP, and mTLS/registry scenarios all print OK and exit 0.

---

## Task T7: Docs, Bazel verification, release

**Files:**
- Modify: `README.md`, `AGENTS.md`, `BUILD.bazel` (if test helper file added)

**Assignee:** Claude Code

- [ ] **Step 1: README**
  - Add "Server mode (mTLS)" after "TCP transport": direct `connectTlsMirror` and `connectMirrorFromRegistry` examples, certificate prerequisites (`ca.crt`, `client.crt`, `client.key`, key mode `0600`).
  - Update the Transports table with the `ModelMirrors --server <port> --tls ...` row.
  - Keep the `register_traces` mirror-local warning; note `register_trace_gen` returns inline `itfTraces` for remote use.

- [ ] **Step 2: AGENTS.md**
  - Architecture: add `src/registry.ts`; note `connectTlsMirror` in `src/transport.ts`.
  - Gotchas: Node built-ins only; TLS 1.3 only; fingerprint is lowercase hex SHA-256 over the **raw DER** leaf cert; `src/protocol.ts` must remain unchanged; `.js` import extensions apply to `./transport.js` from `registry.ts`.

- [ ] **Step 3: Bazel**
  - If `test/tls-certs.ts` was created, add it to `smoke_test` `srcs` and re-check the `data` for any runtime fixture files (none if certs are generated in a temp dir).
  - `src/registry.ts` is already covered by `glob(["src/**/*.ts"])`; verify:

```bash
bazel build //:lib
bazel test //:smoke --test_output=errors
```

Expected: PASSED with the bumped ModelMirrors pin and TLS smoke path.

- [ ] **Step 4: Full verification**

```bash
pnpm run check
pnpm run test
MIRROR_BIN=<ModelMirrors binary> npx tsx test/smoke.test.ts
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add MODULE.bazel MODULE.bazel.lock src/transport.ts src/registry.ts src/client.ts src/index.ts test/registry.test.ts test/smoke.test.ts README.md AGENTS.md docs/superpowers/plans/2026-08-19-server-mode-support.md
git commit -m "feat: support ModelMirrors server mode (mTLS + Consul discovery)"
```

- [ ] **Step 6:** Report: commit hash, test outputs, and any deviations from `docs/server-mode-support.md`.

---

## Completion criteria

1. `src/protocol.ts` has no diff.
2. `connectTlsMirror` rejects on bad CA, wrong client cert, hostname failure, pin mismatch, bad key mode, and timeout.
3. `discoverMirrors` returns `[]` on registry/HTTP/parse failures and parses the documented Consul subset.
4. `connectMirrorFromRegistry` tries candidates in order with explicit pin override and reports aggregated failures.
5. All six existing client flows pass over stdio, legacy TCP, and mTLS in the smoke run.
6. Existing `spawnMirror` / `connectMirror` / `string`-target usage is source-compatible.
7. Bazel `//:lib` builds and `//:smoke` passes after the ModelMirros pin bump.
