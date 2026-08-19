# Design: ModelMirrors Server-Mode Support

**Date:** 2026-08-19
**Status:** planned — implementation plan: `docs/superpowers/plans/2026-08-19-server-mode-support.md`
**Upstream reference:** [ModelMirros `docs/server-mode-design.md`](https://github.com/NzSN/ModelMirrors/blob/main/docs/server-mode-design.md) (current server mode: mTLS + optional Consul service registry)
**Protocol reference:** ModelMirros `docs/protocol-spec.md`, section "Discovery and mTLS (Client Guide)"

## Conclusion: what ModelMirrors server mode is

ModelMirrors server mode is **TLS 1.3 mutual authentication (mTLS) over TCP**, with
**optional Consul service-registry discovery**. It is deliberately transport-only:
the JSON-lines session protocol is unchanged on every transport, and the first
message after transport setup is still one of the `Register*` messages.

| Mode | Mirror invocation | Transport | Authentication | Discovery |
|------|-------------------|-----------|----------------|-----------|
| Stdio (default) | `ModelMirrors` | stdin/stdout | none (child-process trust) | none |
| TCP daemon (legacy) | `ModelMirrors --serve <port>` | plain TCP | none | none |
| Server (mTLS) | `ModelMirrors --server <port> --tls --cert ... --key ... --ca ... [--registry <url>]` | TLS 1.3 over TCP | mutual, private-CA certificates | optional Consul (`--registry`) |

Key properties MirrorECMA must implement against:

1. **mTLS, TLS 1.3 only.** Client validates the server chain against a pinned CA and
   validates the hostname/IP SAN; client presents its own CA-signed certificate and key.
2. **No protocol-level handshake.** After the TLS handshake, send `register`,
   `register_traces`, `register_trace_gen`, `register_explore`, or
   `register_explore_session` exactly as over stdio/TCP. `protocol.ts` stays unchanged.
3. **Optional Consul discovery.** `GET <registry>/v1/health/service/modelmirrors?passing=true`
   returns entries whose `Service.Address`, `Service.Port`, and optional
   `Service.Meta["cert-sha256"]` are used to connect.
4. **Fingerprint pinning is defense in depth.** When a registry entry carries
   `cert-sha256`, compare it with SHA-256 over the DER encoding of the server's leaf
   certificate (lowercase hex). Mismatch means close and try the next candidate.
5. **Fail closed.** Registry unreachable/non-2xx/malformed means "no candidates";
   a forged or compromised registry can at worst cause failed mTLS connections.
6. **Legacy transports remain valid.** Stdio and `--serve` TCP are byte-for-byte
   unchanged; MirrorECMA's existing `spawnMirror` and `connectMirror` remain supported.

The UDP-broadcast design and PSK+HMAC design in the upstream document are legacy /
alternative; MirrorECMA does not implement them.

## Scope

### In scope

- Direct mTLS transport: `connectTlsMirror(host, port, tlsOptions)`.
- Consul-compatible discovery: `discoverMirrors(registryUrl)`.
- One-call connect-with-discovery: `connectMirrorFromRegistry(registryUrl, tlsOptions)`.
- Reuse of all existing client flows over the new transport.
- Fingerprint pinning, candidate failover, fail-closed registry errors.
- Tests for TLS handshakes, negative mTLS cases, registry parsing, and full sessions.

### Out of scope

- Running a ModelMirrors server from MirrorECMA (that is `ModelMirrors --server ...`).
- Consul registration/heartbeat/deregistration (mirror side only).
- UDP broadcast discovery and PSK/HMAC authentication (superseded/alternative upstream).
- `register_validate` (MirrorECMA does not implement the validate flow today).
- Per-client authorization, `--root` filesystem confinement, and DoS hardening.

## Design principles

1. **Transport stays behind the existing `Transport` interface.** Every client entry
   point already accepts `string | Transport`; TLS and registry discovery only add new
   ways to construct a `Transport`.
2. **Session protocol files stay untouched.** No new `proto_step`, no auth messages.
   `src/protocol.ts` is unchanged.
3. **Node built-ins only.** Use `node:tls`, `node:crypto`, `node:net`, `node:stream`,
   `node:readline`, `node:fs/promises`, and global `fetch`. No npm runtime dependency,
   preserving the package's current zero-runtime-dependency posture.
4. **Match Haskell client semantics.** File paths for credentials (`caPath`, `certPath`,
   `keyPath`), TLS 1.3 only, hostname validation, lowercase-hex SHA-256 pinning,
   explicit pin override over registry metadata, try-next-on-failure.
5. **Backward compatible.** `spawnMirror`, `connectMirror`, and the `string` target
   (spawn stdio) keep their current behavior and signatures.

## Public API

### Direct mTLS transport

New in `src/transport.ts`:

```ts
export interface TlsOptions {
  /** PEM CA bundle used to verify the mirror's server chain. */
  caPath: string;
  /** PEM client certificate signed by the same CA. */
  certPath: string;
  /** PEM private key for certPath (must be 0600 on POSIX, like the Haskell client). */
  keyPath: string;
  /** Expected server leaf certificate fingerprint, lowercase hex SHA-256 over DER.
   *  Optional for direct connect; registry connect supplies one automatically. */
  pin?: string;
  /** SNI/hostname checked against the server SAN. Defaults to `host`. */
  servername?: string;
  /** TLS handshake + pin-check timeout. Default 10 000 ms. */
  handshakeTimeoutMs?: number;
}

export interface TlsConnectTransport extends Transport {
  /** Peer leaf certificate SHA-256 (lowercase hex), known once connect returns. */
  readonly peerFingerprint: string;
}

export function connectTlsMirror(
  host: string,
  port: number,
  opts: TlsOptions,
): Promise<TlsConnectTransport>;
```

`connectTlsMirror` is async and, like Haskell's `connectTls`, resolves only after a
successful TLS 1.3 handshake and optional pin check. File-load, DNS, connect,
handshake, hostname/CA validation, timeout, and pin errors reject the returned promise;
a resolved value is a ready transport.

Usage:

```ts
import { connectTlsMirror, runClient } from "mirrorecma";

const transport = await connectTlsMirror("10.0.0.5", 8999, {
  caPath: "./certs/ca.crt",
  certPath: "./certs/client.crt",
  keyPath: "./certs/client.key",
});

await runClient(transport, apalacheConfig, traceConfig, compute);
```

### Registry discovery

New module `src/registry.ts`:

```ts
export interface MirrorServiceInfo {
  id: string;
  host: string;
  port: number;
  /** SHA-256 of the server leaf cert from Consul Meta, if advertised. */
  certSha256?: string;
}

export interface RegistryOptions {
  /** HTTP request timeout. Default 5 000 ms. */
  timeoutMs?: number;
  /** Test seam: injectable fetch (defaults to global fetch). */
  fetch?: typeof fetch;
}

export function discoverMirrors(
  registryUrl: string | URL,
  opts?: RegistryOptions,
): Promise<MirrorServiceInfo[]>;

export interface RegistryConnectOptions extends RegistryOptions {
  /** Explicit pin override; wins over each entry's certSha256. */
  pin?: string;
}

export function connectMirrorFromRegistry(
  registryUrl: string | URL,
  tls: TlsOptions,
  opts?: RegistryConnectOptions,
): Promise<TlsConnectTransport>;
```

`discoverMirrors` follows the upstream client guide:

- `GET <registryUrl>/v1/health/service/modelmirrors?passing=true`.
- Only the `Service` object matters: `ID`, `Address`, `Port`, `Meta["cert-sha256"]`.
- Skip entries with missing/empty `Address` or missing/invalid `Port`
  (integer `1..65535`).
- If `Meta["cert-sha256"]` is present, require a 64-char hex string and normalize to
  lowercase; a malformed value skips the candidate (fail closed). Absent is allowed.
- Any network error, non-2xx status, or malformed JSON returns `[]`; the function does
  not throw for registry-side failures.

`connectMirrorFromRegistry` discovers, then tries candidates in order:

1. `pin = opts.pin ?? service.certSha256` (explicit pin wins, matching Haskell's
   `candidateFingerprint`).
2. `await connectTlsMirror(service.host, service.port, { ...tls, pin })`; the function
   already rejects on handshake, hostname, or pin failure.
3. First successful candidate is returned.
4. If every candidate fails, throw an error whose message contains all per-candidate
   diagnostics, e.g. `no usable mirror discovered from <url>: 10.0.0.5:8999: <reason>;
   10.0.0.6:8999: <reason>`. An empty registry result reports "no candidates discovered".

Usage:

```ts
import { connectMirrorFromRegistry, runClient } from "mirrorecma";

const transport = await connectMirrorFromRegistry(
  "http://consul.local:8500",
  {
    caPath: "./certs/ca.crt",
    certPath: "./certs/client.crt",
    keyPath: "./certs/client.key",
  },
);

await runClient(transport, apalacheConfig, traceConfig, compute);
// explore flows work identically:
// runClientExplore / startExploreSession(transport, ...)
```

## Implementation design

### TLS transport (`src/transport.ts`)

Add the mTLS transport in the same module as the current TCP transport; the existing
private `lineIterator`/readline framing is reused for JSON-lines over the TLS socket.

Implementation sketch:

```ts
import * as tls from "node:tls";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export async function connectTlsMirror(
  host: string,
  port: number,
  opts: TlsOptions,
): Promise<TlsConnectTransport> {
  await assertPrivateKeyMode(opts.keyPath);      // POSIX: mode & 0o077 === 0
  const [ca, cert, key] = await Promise.all([
    readFile(opts.caPath),
    readFile(opts.certPath),
    readFile(opts.keyPath),
  ]);

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

  const peerFingerprint = await completeHandshake(sock, opts);
  // completeHandshake: resolve on secureConnect, reject on error/timeout, then
  // optionally compute sha256(sock.getPeerX509Certificate().raw) and compare
  // against normalized opts.pin. It attaches the readline framing before
  // returning, then installs the post-connect error swallow like connectMirror.

  const it = lineIterator();
  const rl = createInterface({ input: sock, crlfDelay: Infinity });
  rl.on("line", it.emit);
  rl.on("close", it.finish);
  sock.on("close", it.finish);

  return {
    peerFingerprint,
    send(line) { sock.write(line + "\n"); },
    async close() { /* graceful close, 1 s timeout, destroy fallback */ return 0; },
    [Symbol.asyncIterator]() { return { next: it.pull }; },
  };
}
```

Required behavior:

- **TLS 1.3 only.** Set both `minVersion` and `maxVersion` to `"TLSv1.3"`. The server
  accepts no other version.
- **Mutual authentication.** `ca`, `cert`, and `key` are provided; `rejectUnauthorized:
  true` enables server chain + hostname validation, and Node presents the client
  certificate when the server requests it (the server always does).
- **Hostname.** `servername` defaults to `host`; users can override for split-horizon
  DNS or when the SAN contains a canonical name.
- **Key file mode.** On POSIX, `stat(keyPath).mode & 0o077` must be `0`; otherwise
  `connectTlsMirror` rejects with a clear "client key must be 0600" error, matching
  Haskell's `mkClientParams`.
- **Fingerprint pinning.** After `secureConnect`, obtain the peer leaf certificate with
  `sock.getPeerX509Certificate()` (fallback `sock.getPeerCertificate()`), compute
  `createHash("sha256").update(cert.raw).digest("hex")`, and compare to the normalized
  expected pin. Mismatch destroys the socket and rejects the returned promise.
- **Timeout.** A timer covers handshake + pinning (`handshakeTimeoutMs`, default 10 s);
  expiry destroys the socket with a descriptive timeout error.
- **Close.** `close()` sends a graceful TLS close (`sock.end()`), waits for `close`
  with a short timeout (e.g. 1 s), then `destroy()` as fallback, resolving `0`.
- **Framing.** JSON-lines framing is byte-for-byte the existing convention: `send`
  appends `\n`; receive side accumulates lines via `readline` over the TLS socket.
- **No server greeting.** The mirror sends nothing until a `Register*` message, so the
  framing can be attached before or immediately after the handshake completes without
  losing protocol data.

### Client changes (`src/client.ts`)

`connectTlsMirror` already returns a ready transport, so no client change is strictly
required for mTLS. However, the existing TCP `connectMirror` exposes a `ready` promise
that callers currently have to remember to await; a connection refusal is otherwise
reported as "transport closed unexpectedly" after the first protocol send.

As part of this work, harden `resolveTransport` to async and await an optional `ready`
before the first send:

```ts
type MaybeReadyTransport = Transport & { ready?: Promise<void> };

async function resolveTransport(
  target: string | Transport,
): Promise<Transport> {
  const t = typeof target === "string" ? spawnMirror(target) : target;
  const maybeReady = t as MaybeReadyTransport;
  if (maybeReady.ready) await maybeReady.ready;
  return t;
}
```

All entry points (`runClient`, `runClientWithTraces`, `runClientGenTraces`,
`runClientExplore`, `ExploreSession.open`) change `const t = resolveTransport(target)` to
`const t = await resolveTransport(target)`. Signatures do not change. This also improves
existing TCP usage by surfacing connection refusals before the first protocol message.

### Registry module (`src/registry.ts`)

- URL construction joins the registry base with
  `/v1/health/service/modelmirrors?passing=true`, normalizing a missing trailing slash.
- HTTP is plain `fetch` with `signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000)` and
  `Accept: application/json`; this matches the upstream "plain HTTP/JSON, existing
  dependency" approach.
- Parsing is strict and total:
  - response must be an array, each element an object with an object `Service`;
  - `Service.Address` must be a non-empty string after trimming;
  - `Service.Port` must be a finite safe integer in `1..65535`;
  - `Service.Meta["cert-sha256"]`, when present, must be `^[0-9a-fA-F]{64}$`;
  - anything else drops that entry, and top-level malformation yields `[]`.
- No deduplication; Consul preserves server ordering and the helper tries entries in
  order (same as Haskell).
- The candidate connector is the only place mTLS options meet discovery data; registry
  code itself knows nothing about the session protocol.

### Module and export changes

| File | Action | Responsibility |
|------|--------|----------------|
| `src/transport.ts` | Modify | `connectTlsMirror`, `TlsOptions`, `TlsConnectTransport`; reuse `lineIterator` |
| `src/registry.ts` | Create | `discoverMirrors`, `connectMirrorFromRegistry`, `MirrorServiceInfo`, registry parsing |
| `src/client.ts` | Modify | Await optional `Transport.ready` in all entry points |
| `src/index.ts` | Modify | Export new symbols from `transport.js` and `registry.js` |
| `src/protocol.ts` | **No change** | Session protocol is transport-independent |
| `src/spec.ts` | **No change** | Inline specs already make trace flows usable remotely |
| `package.json` | **No change** | No new npm runtime dependencies |
| `MODULE.bazel` | Modify | Bump the `modelmirrors` `git_override` to a commit containing server mode; refresh `MODULE.bazel.lock` |
| `README.md` | Modify | New "Server mode (mTLS)" section; update transport table |
| `test/registry.test.ts` | Create | Parser/discovery unit tests |
| `test/tls.test.ts` or smoke extension | Create | TLS transport + end-to-end session tests |

### Build integration notes

- `src/transport.ts` already uses Node built-ins, so `@types/node` is sufficient.
- Bazel `ts_project` compiles the new modules automatically via the `src/**/*.ts` glob.
- The Bazel smoke test currently pins ModelMirros `015e4b2`; server-mode tests require
  the newer commit. Keep the same local/no-sandbox setup used by the TCP smoke test
  (loopback sockets plus TLS do not need broader sandbox capabilities, but the sandbox
  may still block sockets — hence `tags = ["local", "no-sandbox"]` remains).
- `register_traces` remains documented as mirror-local for `itfTracePaths`; remote
  server-mode users should use `register`, `register_trace_gen` (which returns inlined
  `itfTraces`), or the explore flows.

## Failure modes

| Failure | MirrorECMA behavior |
|---|---|
| Unreadable CA/cert/key or bad PEM | `connectTlsMirror` rejects with a clear file-load error |
| Client key mode not `0600` (POSIX) | `connectTlsMirror` rejects before connecting |
| Server cert not signed by `caPath` / bad hostname SAN | TLS handshake fails; `connectTlsMirror` rejects |
| Server requests a client cert and none/mismatched CA | TLS handshake fails; `connectTlsMirror` rejects |
| Direct-connect pin mismatch | Socket closed; `connectTlsMirror` rejects |
| Registry unreachable, non-2xx, or malformed JSON | `discoverMirrors` returns `[]` (fail closed) |
| Registry entry malformed / missing `Address` / bad `Port` | Entry skipped |
| Registry entry has malformed `cert-sha256` | Entry skipped (no unpinned fallback) |
| Registry pin mismatch on one candidate | Close it, try the next candidate |
| All candidates fail | `connectMirrorFromRegistry` throws with concatenated diagnostics |
| Connection drops mid-session | Existing behavior: iterator closes and client loop throws "transport closed unexpectedly" |
| Peer is legacy `--serve` plain TCP | Clean TLS handshake error; never protocol confusion |

## Security notes

- **Registry is location-only.** A malicious registry entry can only make the client
  attempt mTLS to a host that must pass CA validation and, when advertised, the pin.
- **Pin override.** `RegistryConnectOptions.pin` / `TlsOptions.pin` wins over registry
  metadata. This matches Haskell's explicit `--pin` override.
- **Fingerprint definition.** Lowercase hex SHA-256 over the full DER encoding of the
  server leaf certificate (the first certificate in the presented chain). Normalize
  case before comparison but never trim or re-encode the DER bytes.
- **No pin does not mean no authentication.** A candidate without `cert-sha256` is still
  protected by the mTLS CA validation; pinning is only the second layer.
- **Key material.** Accept credentials as file paths (like the mirror CLI); do not put
  key material in URLs or logs. Error messages include paths but never key contents.
- **Timeouts.** Both registry HTTP and TLS handshake have defaults so a dead candidate
  cannot hang the client indefinitely.

## Implementation phases

### Phase 1 — Direct mTLS transport

- Add `connectTlsMirror`, `TlsOptions`, `TlsConnectTransport` to `src/transport.ts`.
- Add `ready` awaiting in `src/client.ts`; export from `src/index.ts`.
- Gate: `pnpm run check`, existing unit + smoke tests still green; a manual
  `--server --tls` mirror completes one `register` session through the new API.

### Phase 2 — Registry discovery

- Add `src/registry.ts` (`discoverMirrors`, `connectMirrorFromRegistry`).
- Export from `src/index.ts`.
- Gate: unit tests over canned Consul payloads; full session against a local
  `--server --tls --registry <url>` mirror with a stub or real Consul.

### Phase 3 — Test and documentation hardening

- Add negative TLS tests, pin-mismatch failover, registry failure tests.
- Extend `test/smoke.test.ts` with all client flows over TLS (mirror started with
  `--server --tls`), matching the current TCP scenario coverage.
- Bump `MODULE.bazel` ModelMirros pin; add Bazel smoke wiring as feasible.
- Update `README.md` (usage, transport table, `register_traces` remote caveat).

## Test strategy

- **Unit (Jest):**
  - Registry JSON parsing: valid entries, missing `Address`, zero/large `Port`,
    missing vs malformed `cert-sha256`, non-array and malformed top-level responses.
  - Fingerprint normalization and DER hashing against a known certificate fixture.
- **Integration (extend smoke test, or new Jest integration file):**
  - Generate a throwaway CA, server cert with `IP:127.0.0.1` SAN, and client cert with
    `openssl` into a temp dir (never commit keys).
  - Spawn `ModelMirrors --server <port> --tls --cert ... --key ... --ca ...`.
  - Positive: every supported client flow (`register`, `register_traces`,
    `register_trace_gen`, `register_explore`, `register_explore_session`, inline-spec
    `register`) over `connectTlsMirror`.
  - Negative: wrong CA client rejected; rogue client cert rejected; direct pin mismatch
    rejected.
  - Registry: stub HTTP server returns a canned Consul payload; `connectMirrorFromRegistry`
    discovers and connects. Second test returns malformed JSON and expects fail-closed.
  - Failover: registry advertises a bad pin first and a correct pin second; helper
    connects to the second candidate.
- **Bazel:** after the ModelMirros pin bump, run `bazel test //:smoke` with the existing
  local/no-sandbox tags. TLS cert generation uses the system `openssl` available to the
  local test; hermetic alternatives (committed fixture or rules_openssl) are follow-ups.

## Acceptance criteria

1. `pnpm run check` and `pnpm run test` are green.
2. `MIRROR_BIN=<ModelMirrors binary> npx tsx test/smoke.test.ts` passes stdio, legacy
   TCP, and mTLS server scenarios.
3. A fresh clone can follow README steps to:
   - generate certs with ModelMirrors `scripts/gen-certs.sh`,
   - start `ModelMirrors --server <port> --tls ...`,
   - connect with `connectTlsMirror`, or discover+connect with
     `connectMirrorFromRegistry`.
4. Existing `spawnMirror` and `connectMirror` usage has no source-level changes.
5. `src/protocol.ts` has no diff in the implementing PR.
