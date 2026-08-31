# Async jobs, sync validate, and error-path hardening — design

> Closes the remaining conformance gaps between MirrorECMA and the Mirrors
> `Docs/client-implementation-guide.md` (C-rules C16–C23 plus robustness
> items), after a review against the Lean 4 mirror. Already closed on
> `main` before this design: explorer sessions, inline spec transfer
> (`specFromFiles`), `step_mismatch` diff hints, `0600` client-key
> enforcement.

Normative references: `Docs/client-implementation-guide.md` (behavioral
rules), `Docs/interface-reference.md` §3.4/§4 (wire shapes),
`test/fixtures/{client,mirror}_messages.jsonl` (golden pins).

## Remaining gaps addressed

| Gap | Rule(s) | Disposition |
| --- | ------- | ----------- |
| No async job interface | C17–C23 | **D1** — new `Connection` + job API |
| No sync `register_validate` | C16, C14 | **D2** — `Connection.validate` + one-shot |
| Transport leaked on error paths | C6, C8 (DoS surface) | **D3** — hardening (P3) |
| `destPath` required though wire allows `null`; `spec_validated` decode cast | C14 | **D4** — polish (P3) |

## D1 — Async job client

### D1.1 Protocol surface (`src/protocol.ts`)

New client messages (all optional keys omitted-on-encode, C14):

- `register_validate` `{apalacheConfig, bound, spec?}` (sync, D2)
- `register_validate_async` `{apalacheConfig, bound, spec?}`
- `register_trace_gen_async` `{apalacheConfig, traceConfig, destPath?, spec?}`
- `query_job {jobId}` / `await_job {jobId, timeoutSecs?}` / `cancel_job {jobId}`

New mirror messages (shapes pinned by `test/fixtures/mirror_messages.jsonl`):

- `job_accepted {jobId, kind: "validate"|"gen_traces"}`
- `job_status {jobId, phase}` — `pending|running` (non-terminal),
  `done|failed|cancelled` (terminal, absorbing), `unknown`
  (never-submitted or evicted, C21)
- `job_result {jobId, outcome}` — terminal, idempotent (C18);
  `outcome` is one of `{validate: ValidateResult}` (identical to the
  sync `register_validate` reply, C20), `{genTraces: {itfTracePaths,
  itfTraces}}`, `{error: string}` (infra failure — **not** a spec
  verdict, guide §9)

`ValidateResult = "valid" | { invalid: string }` is shared between the
sync and async validate paths (the C20 dividend).

### D1.2 `Connection` (`src/connection.ts`) — the enabling abstraction

C17 makes jobs cross-connection visible, so connection identity must be
user-controllable (today's `run*` one-shots hide the transport). The
existing one-shots stay untouched for back-compat.

```ts
class Connection {
  static open(target: string | Transport, opts?: { mode?: "stdio" | "network" }): Promise<Connection>;
  close(): Promise<void>;   // idempotent; C6: dropping cancels+evicts THIS connection's jobs

  // sync validate (D2); consumes the connection's session (C5)
  validate(cfg, bound, opts?: { spec? }): Promise<ValidateResult>;

  // async jobs (network connections only)
  submitValidateAsync(cfg, bound, opts?): Promise<JobHandle>;
  submitTraceGenAsync(cfg, traceConfig, opts?: { spec?, destPath?: string | null }): Promise<JobHandle>;
  queryJob(jobId): Promise<JobStatus>;                       // unknown phase returned verbatim (C21)
  awaitJob(jobId, timeoutSecs?): Promise<AwaitResult>;       // long-poll, C18
  cancelJob(jobId): Promise<JobResult | JobStatus>;          // C19
  ping(): Promise<boolean>;                                  // C7 liveness MAY: query_job("__ping__") → "unknown"
}

type AwaitResult =
  | { done: true; result: JobResult }      // terminal, idempotent
  | { done: false; status: JobStatus };    // timeoutSecs elapsed — never an error

class JobHandle {   // submit result; methods delegate to its connection
  readonly jobId: string; readonly kind: JobKind; readonly connection: Connection;
  query(): Promise<JobStatus>;
  await(timeoutSecs?): Promise<AwaitResult>;   // unknown ⇒ JobEvictedError (never poll forever, C21+C6)
  cancel(): Promise<JobResult | JobStatus>;
}
```

Behavioral rules baked in:

- **Per-connection serialization.** The wire is lock-step per
  connection; ops are funneled through a promise queue so concurrent
  `awaitJob`/`queryJob` calls can never interleave request/reply
  pairs. A blocking `awaitJob` (no timeout) therefore blocks later ops
  on the *same* connection — documented; concurrent waits belong on
  separate connections (cheap by design, guide §7).
- **Stdio guard (guide §6).** Async ops on a stdio connection throw
  `AsyncOnStdioError` before any bytes. Transports carry an optional
  `mode: "stdio" | "network"` marker (set by `spawnMirror` /
  `connectMirror` / `connectTlsMirror`; overridable in `open` opts).
- **Divergence tolerance (guide §9).** Out-of-phase/async-in-stdio is
  answered `register_error` by the Lean mirror but `protocol_error` by
  Haskell — submits map *both* to `RegisterFailedError`.
- **Queue full (C22).** `register_error` matching `/queue full/i` at
  submit ⇒ typed `JobQueueFullError` (catchable; callers back off).
- **Bound pre-check (C16).** `bound ∉ [1,100]` ⇒ `RangeError` locally,
  before any bytes (the server would reject synchronously anyway).
- **Flow consumption (C5).** A terminal sync flow (`validate`, or the
  existing MBT loops) ends the session: subsequent ops on that
  connection throw `ConnectionClosedError`; open a new connection
  instead. `job_accepted` is *not* terminal — async ops may follow
  async submits on the same connection.
- **Cancel (C19).** Returns the server's reply verbatim (`job_result`
  if already terminal, else `job_status`); documented as cooperative
  but lethal to the apalache child — prefer it over dropping the
  connection.

Error taxonomy (new, exported): `RegisterFailedError`,
`JobQueueFullError`, `JobEvictedError`, `AsyncOnStdioError`,
`ProtocolFailureError`, `ConnectionClosedError`.

### D1.3 Decode dispatcher

With the job messages added, every `proto_step` in the golden corpus
has a real decoder; the synthetic `protocol_error` fallback remains
purely as forward-compat tolerance (C3).

## D2 — Sync `register_validate` (C16)

`Connection.validate()` sends `register_validate {apalacheConfig,
bound, spec?}` and expects the single terminal `spec_validated`;
`register_error` ⇒ `RegisterFailedError`, `protocol_error` ⇒
`ProtocolFailureError`. One-shot convenience, matching existing helper
style:

```ts
runClientValidate(target: string | Transport, cfg, bound, opts?): Promise<ValidateResult>
```

Works on stdio and network connections. Gives TypeScript users the
guide §10.5 self-check flow (`mirror validate` parity).

## D3 — Error-path hardening (P3)

- `mainLoop` / `genTracesLoop` / `ExploreSession`: `try/finally`
  close, idempotent; a `compute()` throw or a decode failure currently
  leaks the transport, wedging the session and parking a server pool
  worker (the C8-documented DoS surface — self-inflicted today).
- `ExploreSession`: reject method calls after `done()`; make `done()`
  idempotent.
- `recv()`: on `JSON.parse` failure, close and rethrow with the
  offending line truncated (~200 chars).
- `spawnMirror.close()`: SIGTERM the child if it doesn't exit within
  ~2 s of `stdin.end()`.

## D4 — Conformance polish (P3)

1. `RegisterTraceGen.destPath: string | null` — wire allows `null`
   (C14); with inline `itfTraces` returned, `null` is the natural
   choice against remote servers. (Async variant ships nullable from
   day one.)
2. `spec_validated` decode: only the exact string `"valid"` decodes to
   success; other strings become `{invalid: <string>}`.
3. `Connection.ping()` liveness helper (C7 MAY) — included in P1 since
   it falls out of `queryJob`.

## D5 — Test plan

**Unit (`test/protocol.test.ts`)** — pin the golden lines verbatim:
all six `job_status` phases, all three `job_result` outcomes,
`job_accepted` (both kinds), `query_job`, `await_job` with and without
`timeoutSecs`, `cancel_job`, both async submits, sync
`register_validate`; absent-vs-null optional keys.

**Scripted fake server (`test/async.test.ts`)** — a `net.createServer`
replying canned lines, asserting: submit→`job_accepted`; query
transitions; await→terminal; await-timeout ⇒ non-terminal `job_status`
(never an error); re-await idempotence; cancel; unknown id ⇒ verbatim
on `queryJob`, `JobEvictedError` on `JobHandle.await`; queue full ⇒
`JobQueueFullError`; generic `register_error` ⇒ `RegisterFailedError`;
`protocol_error` on submit ⇒ `RegisterFailedError` (divergence);
out-of-range bound ⇒ `RangeError` with zero bytes sent; stdio ⇒
`AsyncOnStdioError`; sync validate valid/invalid/`register_error`;
flow-consumed ⇒ `ConnectionClosedError`; idempotent `close()`.

**Live smoke (P2, `test/smoke.test.ts`, run unmodified by the Mirrors
`tools/interop/run.sh` matrix)** — against `mirror --serve --jobs 2`:
sync validate (valid + invalid); validate_async→await with payload
diffed against the sync reply (C20); trace_gen_async with
`destPath: null` consuming inline `itfTraces`; cancel mid-run;
cross-connection submit-on-A/await-on-B (C17); C6 negative: close A,
query from B ⇒ `unknown`; queue-full negative on `--jobs 1`.

## Acceptance mapping

D1.1/D1.2 → C17–C23; D2 → C16 (+C14); D3 → C6/C8; D4 → C14/C11 parity;
fake-server + smoke negatives → guide §9 obligations.

## Phasing

- **P1** (this change): protocol types, `Connection`, D2, async
  submit/query/await/cancel, unit + fake-server tests, `ping`.
- **P2**: live smoke extensions (async + C6/C17/C22 scenarios).
- **P3**: D3 hardening + D4 polish (independent; can land any time).
