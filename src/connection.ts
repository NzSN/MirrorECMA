// Connection: a first-class, user-controlled mirror session.
//
// The async job interface (client guide section 6, rules C17-C23) makes
// jobs visible across connections, so connection identity must be in the
// caller's hands — unlike the run* one-shot helpers, which open and close
// a transport inside a single call. A Connection wraps one Transport and
// serializes lock-step request/reply exchanges over it.
//
// Session rules baked in (client guide):
//  - C5:  a terminal synchronous flow (validate) spends the connection;
//         subsequent operations throw ConnectionClosedError.
//  - C6:  close() drops the connection; the mirror cancels and evicts
//         exactly this connection's jobs.
//  - C16: validate bounds outside [1, 100] throw RangeError before any
//         bytes are sent (the mirror would reject them synchronously).
//  - C17: any connection may operate on any live job id; JobHandle is a
//         convenience bound to its submitting connection.
//  - C18: awaitJob long-polls; a timeout yields a non-terminal
//         job_status, never an error; terminal results are idempotent.
//  - C19: cancel is cooperative but kills the apalache child — prefer
//         it over dropping the connection.
//  - C21: phase "unknown" means never-submitted or evicted; queryJob
//         returns it verbatim, JobHandle.await raises JobEvictedError
//         rather than polling forever.
//  - C22: a full job queue rejects at submit with register_error;
//         surfaced as the typed JobQueueFullError.
//  - section 6/9: async messages on stdio are rejected; the Lean mirror
//         answers register_error, Haskell answers protocol_error — both
//         are treated as submit failures (RegisterFailedError).

import {
  encodeClientMessage,
  decodeMirrorMessage,
  type ApalacheConfig,
  type ApalacheSpec,
  type AwaitJob,
  type ClientMessage,
  type JobKind,
  type JobResult,
  type JobStatus,
  type MirrorMessage,
  type TraceGenerationConfig,
  type ValidateResult,
} from "./protocol.js";
import { spawnMirror, type Transport } from "./transport.js";

// ---- Error taxonomy ----

/** register_error from the mirror: bad spec, infra failure, bad bound,
 *  queue full, async-in-stdio — terminal for that register attempt. */
export class RegisterFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegisterFailedError";
  }
}

/** The job queue was full at submit time (C22); catch and back off. */
export class JobQueueFullError extends RegisterFailedError {
  constructor(message: string) {
    super(message);
    this.name = "JobQueueFullError";
  }
}

/** The job id is unknown to the mirror: never submitted, or evicted
 *  after its submitting connection dropped (C6/C21). */
export class JobEvictedError extends Error {
  constructor(public readonly jobId: string) {
    super(
      `job ${jobId} is unknown to the mirror: never submitted, ` +
        `or evicted after its connection dropped`,
    );
    this.name = "JobEvictedError";
  }
}

/** Async job operations require a server-mode connection
 *  (--serve/--server); stdio sessions are sync-only (guide section 6). */
export class AsyncOnStdioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsyncOnStdioError";
  }
}

/** protocol_error from the mirror, or a reply that broke the expected
 *  exchange shape — almost always a client bug (guide section 9). */
export class ProtocolFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolFailureError";
  }
}

/** The connection is closed, or its session flow already terminated. */
export class ConnectionClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionClosedError";
  }
}

// ---- Options and result types ----

export interface ConnectionOptions {
  /** Override the transport's session marker. Rarely needed: the
   *  transport constructors set it correctly. */
  mode?: "stdio" | "network";
}

export interface ValidateOptions {
  /** Inline spec sources (see specFromFiles); omitted = server-side
   *  apalacheConfig.specPath (guide C13/C14). */
  spec?: ApalacheSpec;
}

export interface SubmitTraceGenOptions extends ValidateOptions {
  /** Server-side directory to copy traces into; null/omitted keeps them
   *  server-temporary and uses the inline itfTraces of the outcome. */
  destPath?: string | null;
}

/** Result of awaitJob: terminal job_result (idempotent, C18), or a
 *  non-terminal job_status when timeoutSecs elapsed — never an error. */
export type AwaitResult =
  | { done: true; result: JobResult }
  | { done: false; status: JobStatus };

const QUEUE_FULL_RE = /queue full/i;

function assertValidateBound(bound: number): void {
  if (!Number.isInteger(bound) || bound < 1 || bound > 100) {
    throw new RangeError(`validate bound ${bound} outside allowed range 1..100`);
  }
}

// ---- JobHandle ----

/** A submitted job, bound to its submitting connection (C6: if that
 *  connection drops, the job is cancelled and evicted regardless of who
 *  is awaiting). */
export class JobHandle {
  constructor(
    public readonly connection: Connection,
    public readonly jobId: string,
    public readonly kind: JobKind,
  ) {}

  /** Current phase (job_status), or the terminal job_result when the
   *  job already has an outcome. "unknown" is returned verbatim (C21). */
  query(): Promise<JobStatus | JobResult> {
    return this.connection.queryJob(this.jobId);
  }

  /** Long-poll this job (C18). Throws JobEvictedError if the job went
   *  "unknown" instead of polling forever (C21). */
  async await(timeoutSecs?: number): Promise<AwaitResult> {
    const r = await this.connection.awaitJob(this.jobId, timeoutSecs);
    if (!r.done) {
      // Explicit cast: boolean-discriminant narrowing is not reliable
      // under non-strict compiler settings.
      const status = (r as { done: false; status: JobStatus }).status;
      if (status.phase === "unknown") throw new JobEvictedError(this.jobId);
    }
    return r;
  }

  /** Cooperative cancellation; kills the apalache child (C19). Returns
   *  the mirror's reply: job_result if already terminal, job_status
   *  otherwise. */
  cancel(): Promise<JobResult | JobStatus> {
    return this.connection.cancelJob(this.jobId);
  }
}

// ---- Connection ----

export class Connection {
  private constructor(
    private readonly t: Transport,
    private readonly it: AsyncIterator<string>,
    private readonly mode: "stdio" | "network",
  ) {}

  /**
   * Open a Connection over a mirror endpoint: a string spawns a stdio
   * mirror; a Transport (connectMirror / connectTlsMirror /
   * connectMirrorFromRegistry / spawnMirror) is adopted. The connection
   * takes over the transport's line iterator — do not interleave raw
   * iteration with Connection operations.
   */
  static async open(
    target: string | Transport,
    opts: ConnectionOptions = {},
  ): Promise<Connection> {
    if (typeof target === "string") {
      const t = spawnMirror(target);
      return new Connection(t, t[Symbol.asyncIterator](), "stdio");
    }
    const ready = (target as Transport & { ready?: Promise<void> }).ready;
    if (ready) await ready;
    return new Connection(
      target,
      target[Symbol.asyncIterator](),
      opts.mode ?? target.mode ?? "network",
    );
  }

  get isStdio(): boolean {
    return this.mode === "stdio";
  }

  /**
   * Close the underlying transport. Idempotent. C6: the mirror cancels
   * and evicts this connection's own jobs on disconnect — prefer
   * cancel() for jobs you merely no longer need (C19). In-flight
   * operations surface the closure rather than hanging.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.t.close();
  }

  // ---- Synchronous validate (guide section 3.4, C16) ----

  /**
   * register_validate: a single terminal spec_validated reply. This is
   * a complete session flow (C5): afterwards the connection is spent
   * and further operations throw ConnectionClosedError.
   */
  async validate(
    apalacheConfig: ApalacheConfig,
    bound: number,
    opts: ValidateOptions = {},
  ): Promise<ValidateResult> {
    assertValidateBound(bound);
    return this.op(async () => {
      this.assertFlowOpen();
      const reply = await this.roundTrip(
        encodeClientMessage({
          proto_step: "register_validate",
          apalacheConfig,
          bound,
          spec: opts.spec,
        }),
      );
      // Any reply to a register attempt ends the session flow (C5 +
      // guide section 9: register_error is terminal for the attempt).
      this.flowConsumed = true;
      switch (reply.proto_step) {
        case "spec_validated":
          return reply.result;
        case "register_error":
          throw new RegisterFailedError(reply.error);
        case "protocol_error":
          return this.poisonAndThrow(reply.error);
        default:
          return this.poisonAndThrow(
            `expected spec_validated, got ${reply.proto_step}`,
          );
      }
    });
  }

  // ---- Async job interface (guide section 6, C17-C23) ----

  /** register_validate_async: submit a bounded validation job. */
  async submitValidateAsync(
    apalacheConfig: ApalacheConfig,
    bound: number,
    opts: ValidateOptions = {},
  ): Promise<JobHandle> {
    assertValidateBound(bound);
    return this.submit({
      proto_step: "register_validate_async",
      apalacheConfig,
      bound,
      spec: opts.spec,
    });
  }

  /** register_trace_gen_async: submit a trace generation job. */
  async submitTraceGenAsync(
    apalacheConfig: ApalacheConfig,
    traceConfig: TraceGenerationConfig,
    opts: SubmitTraceGenOptions = {},
  ): Promise<JobHandle> {
    return this.submit({
      proto_step: "register_trace_gen_async",
      apalacheConfig,
      traceConfig,
      destPath: opts.destPath ?? null,
      spec: opts.spec,
    });
  }

  /** query_job: snapshot of a job's phase. The mirror answers job_status
   *  for live/unknown ids and job_result for terminal jobs that have an
   *  outcome. "unknown" (never-submitted or evicted) is returned
   *  verbatim — do not retry-loop on it (C21). */
  async queryJob(jobId: string): Promise<JobStatus | JobResult> {
    return this.op(async () => {
      this.assertAsyncAllowed();
      const reply = await this.roundTrip(
        encodeClientMessage({ proto_step: "query_job", jobId }),
      );
      if (reply.proto_step === "job_status" || reply.proto_step === "job_result") {
        return reply;
      }
      if (reply.proto_step === "register_error") throw new RegisterFailedError(reply.error);
      return this.poisonAndThrow(
        reply.proto_step === "protocol_error" ? reply.error :
        `expected job_status or job_result, got ${reply.proto_step}`,
      );
    });
  }

  /**
   * await_job: long-poll (C18). Without timeoutSecs, blocks until the
   * job terminates; with it, a timeout returns { done: false, status }
   * — never an error. Terminal results are idempotent: re-awaiting a
   * finished job returns the same job_result until eviction.
   *
   * Note: while a no-timeout awaitJob is blocked, later operations on
   * the SAME connection queue behind it (lock-step wire). Await
   * concurrently on separate connections instead (guide section 7).
   */
  async awaitJob(jobId: string, timeoutSecs?: number): Promise<AwaitResult> {
    return this.op(async () => {
      this.assertAsyncAllowed();
      const msg: AwaitJob =
        timeoutSecs === undefined
          ? { proto_step: "await_job", jobId }
          : { proto_step: "await_job", jobId, timeoutSecs };
      const reply = await this.roundTrip(encodeClientMessage(msg));
      if (reply.proto_step === "job_result") return { done: true, result: reply };
      if (reply.proto_step === "job_status") return { done: false, status: reply };
      if (reply.proto_step === "register_error") throw new RegisterFailedError(reply.error);
      return this.poisonAndThrow(
        reply.proto_step === "protocol_error" ? reply.error :
        `expected job_result or job_status, got ${reply.proto_step}`,
      );
    });
  }

  /** cancel_job: cooperative cancellation, lethal to the apalache child
   *  (C19). Returns the mirror's reply verbatim: job_result when the
   *  job was already terminal, job_status otherwise. */
  async cancelJob(jobId: string): Promise<JobResult | JobStatus> {
    return this.op(async () => {
      this.assertAsyncAllowed();
      const reply = await this.roundTrip(
        encodeClientMessage({ proto_step: "cancel_job", jobId }),
      );
      if (reply.proto_step === "job_result" || reply.proto_step === "job_status") {
        return reply;
      }
      if (reply.proto_step === "register_error") throw new RegisterFailedError(reply.error);
      return this.poisonAndThrow(
        reply.proto_step === "protocol_error" ? reply.error :
        `expected job_result or job_status, got ${reply.proto_step}`,
      );
    });
  }

  /**
   * Liveness probe (C7 MAY): a healthy server-mode mirror answers
   * query_job for a never-submitted id with phase "unknown". Anything
   * else — wrong reply, error, exception — reads as not-live.
   */
  async ping(): Promise<boolean> {
    if (this.mode === "stdio" || this.closed || this.flowConsumed) return false;
    try {
      const reply = await this.queryJob("__mirrorecma_ping__");
      return reply.proto_step === "job_status" && reply.phase === "unknown";
    } catch {
      return false;
    }
  }

  // ---- Internals ----

  private closed = false;
  private flowConsumed = false;
  private queue: Promise<unknown> = Promise.resolve();

  /** Serialize lock-step exchanges: concurrent operations must never
   *  interleave their request/reply pairs on the single line stream. */
  private op<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new ConnectionClosedError("connection is closed"));
    }
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async roundTrip(line: string): Promise<MirrorMessage> {
    try {
      this.t.send(line);
      const { value, done } = await this.it.next();
      if (done) {
        return this.poisonAndThrow("mirror closed the connection mid-request");
      }
      return decodeMirrorMessage(value);
    } catch (err) {
      if (this.closed) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return this.poisonAndThrow(`failed protocol exchange: ${message}`);
    }
  }

  private assertFlowOpen(): void {
    if (this.closed) throw new ConnectionClosedError("connection is closed");
    if (this.flowConsumed) {
      throw new ConnectionClosedError(
        "session flow already terminated on this connection; open a new one",
      );
    }
  }

  private assertAsyncAllowed(): void {
    this.assertFlowOpen();
    if (this.mode === "stdio") {
      throw new AsyncOnStdioError(
        "async jobs are only available on server-mode connections " +
          "(--serve/--server), not on a stdio session",
      );
    }
  }

  private async poisonAndThrow(message: string): Promise<never> {
    this.flowConsumed = true;
    try { await this.close(); } catch { this.closed = true; }
    throw new ProtocolFailureError(message);
  }

  private submit(msg: ClientMessage): Promise<JobHandle> {
    return this.op(async () => {
      this.assertAsyncAllowed();
      const reply = await this.roundTrip(encodeClientMessage(msg));
      if (reply.proto_step === "job_accepted") {
        return new JobHandle(this, reply.jobId, reply.kind);
      }
      if (reply.proto_step === "register_error") {
        if (QUEUE_FULL_RE.test(reply.error)) throw new JobQueueFullError(reply.error);
        throw new RegisterFailedError(reply.error);
      }
      // A protocol_error identifies a client/session bug. Unlike a
      // register_error, it poisons this physical connection (guide §9).
      if (reply.proto_step === "protocol_error") {
        return this.poisonAndThrow(reply.error);
      }
      return this.poisonAndThrow(`expected job_accepted, got ${reply.proto_step}`);
    });
  }
}

/**
 * One-shot synchronous validate, in the style of the existing run*
 * helpers: opens a connection, validates, closes. bound must be in
 * [1, 100] (C16). The result is congruent with what an async validate
 * job would produce for the same config (C20).
 */
export async function runClientValidate(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  bound: number,
  opts: ValidateOptions = {},
): Promise<ValidateResult> {
  const conn = await Connection.open(target);
  try {
    return await conn.validate(apalacheConfig, bound, opts);
  } finally {
    await conn.close();
  }
}
