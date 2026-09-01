// Scripted fake-server tests for the Connection async job interface and
// the synchronous validate flow (design: docs/superpowers/specs/
// 2026-08-31-async-jobs-and-validate-design.md, section D5).

import { createServer, type Server, type Socket } from "node:net";
import {
  AsyncOnStdioError,
  Connection,
  ConnectionClosedError,
  connectMirror,
  JobEvictedError,
  JobQueueFullError,
  ProtocolFailureError,
  RegisterFailedError,
  runClientValidate,
  type ApalacheConfig,
  type Transport,
} from "../src/index.js";

const CFG: ApalacheConfig = { specPath: "s.tla", invariant: "Inv", lengthBound: 3 };

type WireMessage = Record<string, unknown>;
type ReplyFn = (msg: WireMessage) => void;

interface FakeMirror {
  port: number;
  requests: WireMessage[];
  close: () => Promise<void>;
}

/** A scripted lock-step mirror: every decoded request line is handed to
 *  `handler`, which answers through `reply`. */
async function startFakeMirror(
  handler: (req: WireMessage, reply: ReplyFn) => void,
): Promise<FakeMirror> {
  const requests: WireMessage[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const req = JSON.parse(line) as WireMessage;
        requests.push(req);
        handler(req, (msg) => sock.write(JSON.stringify(msg) + "\n"));
      }
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no addr");
  return {
    port: addr.port,
    requests,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

async function openConn(port: number): Promise<Connection> {
  return Connection.open(connectMirror("127.0.0.1", port));
}

describe("Connection async job interface", () => {
  it("submits a validate job and returns a handle", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "register_validate_async")
        reply({ proto_step: "job_accepted", jobId: "job-1", kind: "validate" });
    });
    const conn = await openConn(fake.port);
    const handle = await conn.submitValidateAsync(CFG, 5);
    expect(handle.jobId).toBe("job-1");
    expect(handle.kind).toBe("validate");
    expect(handle.connection).toBe(conn);
    expect(fake.requests[0]).toEqual({
      proto_step: "register_validate_async",
      apalacheConfig: { specPath: "s.tla", invariant: "Inv", lengthBound: 3 },
      bound: 5,
    });
    await conn.close();
    await fake.close();
  });

  it("submits a trace-gen job with explicit null destPath", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "register_trace_gen_async")
        reply({ proto_step: "job_accepted", jobId: "job-2", kind: "gen_traces" });
    });
    const conn = await openConn(fake.port);
    const handle = await conn.submitTraceGenAsync(CFG, { numTraces: 2 });
    expect(handle.kind).toBe("gen_traces");
    expect(fake.requests[0]).toEqual({
      proto_step: "register_trace_gen_async",
      apalacheConfig: { specPath: "s.tla", invariant: "Inv", lengthBound: 3 },
      traceConfig: { numTraces: 2 },
      destPath: null,
    });
    await conn.close();
    await fake.close();
  });

  it("queryJob returns phases, unknown verbatim", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "query_job") {
        const phase = req.jobId === "job-gone" ? "unknown" : "running";
        reply({ proto_step: "job_status", jobId: req.jobId, phase });
      }
    });
    const conn = await openConn(fake.port);
    expect(await conn.queryJob("job-1")).toEqual({
      proto_step: "job_status",
      jobId: "job-1",
      phase: "running",
    });
    expect(await conn.queryJob("job-gone")).toEqual({
      proto_step: "job_status",
      jobId: "job-gone",
      phase: "unknown",
    });
    await conn.close();
    await fake.close();
  });

  it("queryJob on a terminal job returns its job_result", async () => {
    // The Lean mirror answers query_job with job_result (not job_status)
    // once a terminal outcome exists (Shell/Mirror/Session.lean).
    const outcome = { validate: "valid" };
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "query_job")
        reply({ proto_step: "job_result", jobId: req.jobId, outcome });
    });
    const conn = await openConn(fake.port);
    expect(await conn.queryJob("job-1")).toEqual({
      proto_step: "job_result",
      jobId: "job-1",
      outcome,
    });
    await conn.close();
    await fake.close();
  });

  it("awaitJob: timeout yields non-terminal status, no timeout yields result", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "await_job") {
        if (req.timeoutSecs !== undefined)
          reply({ proto_step: "job_status", jobId: req.jobId, phase: "running" });
        else
          reply({
            proto_step: "job_result",
            jobId: req.jobId,
            outcome: { validate: "valid" },
          });
      }
    });
    const conn = await openConn(fake.port);
    const timedOut = await conn.awaitJob("job-1", 1);
    expect(timedOut).toEqual({
      done: false,
      status: { proto_step: "job_status", jobId: "job-1", phase: "running" },
    });
    const finished = await conn.awaitJob("job-1");
    expect(finished.done).toBe(true);
    if (finished.done) {
      expect(finished.result).toEqual({
        proto_step: "job_result",
        jobId: "job-1",
        outcome: { validate: "valid" },
      });
    }
    await conn.close();
    await fake.close();
  });

  it("re-awaiting a finished job is idempotent", async () => {
    const outcome = {
      genTraces: { itfTracePaths: ["out/itf/t1.itf.json"], itfTraces: [] },
    };
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "await_job")
        reply({ proto_step: "job_result", jobId: req.jobId, outcome });
    });
    const conn = await openConn(fake.port);
    const first = await conn.awaitJob("job-9");
    const second = await conn.awaitJob("job-9");
    expect(first).toEqual(second);
    expect(second).toEqual({
      done: true,
      result: { proto_step: "job_result", jobId: "job-9", outcome },
    });
    await conn.close();
    await fake.close();
  });

  it("cancelJob returns the mirror's reply verbatim", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "cancel_job")
        reply({ proto_step: "job_status", jobId: req.jobId, phase: "cancelled" });
    });
    const conn = await openConn(fake.port);
    expect(await conn.cancelJob("job-1")).toEqual({
      proto_step: "job_status",
      jobId: "job-1",
      phase: "cancelled",
    });
    await conn.close();
    await fake.close();
  });

  it("JobHandle.await throws JobEvictedError on unknown phase", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "register_validate_async")
        reply({ proto_step: "job_accepted", jobId: "job-1", kind: "validate" });
      if (req.proto_step === "await_job")
        reply({ proto_step: "job_status", jobId: req.jobId, phase: "unknown" });
    });
    const conn = await openConn(fake.port);
    const handle = await conn.submitValidateAsync(CFG, 5);
    await expect(handle.await(1)).rejects.toBeInstanceOf(JobEvictedError);
    await conn.close();
    await fake.close();
  });

  it("queue full at submit maps to JobQueueFullError", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "register_validate_async")
        reply({ proto_step: "register_error", error: "job queue full" });
    });
    const conn = await openConn(fake.port);
    const err = await conn.submitValidateAsync(CFG, 5).catch((e) => e);
    expect(err).toBeInstanceOf(JobQueueFullError);
    expect(err).toBeInstanceOf(RegisterFailedError); // subtype
    await conn.close();
    await fake.close();
  });

  it("generic register_error maps to RegisterFailedError (not queue-full)", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "register_validate_async")
        reply({ proto_step: "register_error", error: "bad spec source" });
    });
    const conn = await openConn(fake.port);
    const err = await conn.submitValidateAsync(CFG, 5).catch((e) => e);
    expect(err).toBeInstanceOf(RegisterFailedError);
    expect(err).not.toBeInstanceOf(JobQueueFullError);
    await conn.close();
    await fake.close();
  });

  it("protocol_error at submit poisons the connection", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "register_validate_async")
        reply({ proto_step: "protocol_error", error: "async not in stdio session" });
    });
    const conn = await openConn(fake.port);
    await expect(conn.submitValidateAsync(CFG, 5)).rejects.toBeInstanceOf(
      ProtocolFailureError,
    );
    await expect(conn.queryJob("job-1")).rejects.toBeInstanceOf(ConnectionClosedError);
    await conn.close();
    await fake.close();
  });

  it("out-of-range bound throws RangeError before any bytes", async () => {
    const fake = await startFakeMirror(() => {});
    const conn = await openConn(fake.port);
    await expect(conn.submitValidateAsync(CFG, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(conn.submitValidateAsync(CFG, 101)).rejects.toBeInstanceOf(RangeError);
    await expect(conn.submitValidateAsync(CFG, 2.5)).rejects.toBeInstanceOf(RangeError);
    expect(fake.requests).toHaveLength(0);
    await conn.close();
    await fake.close();
  });

  it("async ops on stdio are rejected before any bytes", async () => {
    const sent: string[] = [];
    const stdioTransport: Transport = {
      mode: "stdio",
      send: (line) => {
        sent.push(line);
      },
      close: async () => 0,
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<string>>(() => {}),
      }),
    };
    const conn = await Connection.open(stdioTransport);
    expect(conn.isStdio).toBe(true);
    await expect(conn.submitValidateAsync(CFG, 5)).rejects.toBeInstanceOf(
      AsyncOnStdioError,
    );
    await expect(conn.queryJob("job-1")).rejects.toBeInstanceOf(AsyncOnStdioError);
    await expect(conn.awaitJob("job-1", 1)).rejects.toBeInstanceOf(AsyncOnStdioError);
    await expect(conn.cancelJob("job-1")).rejects.toBeInstanceOf(AsyncOnStdioError);
    expect(sent).toHaveLength(0);
    expect(await conn.ping()).toBe(false);
    await conn.close();
  });

  it("ping reads liveness from the unknown phase", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "query_job")
        reply({ proto_step: "job_status", jobId: req.jobId, phase: "unknown" });
    });
    const conn = await openConn(fake.port);
    expect(await conn.ping()).toBe(true);
    await conn.close();
    expect(await conn.ping()).toBe(false);
    await fake.close();
  });

  it("close is idempotent; ops after close reject", async () => {
    const fake = await startFakeMirror(() => {});
    const conn = await openConn(fake.port);
    await conn.close();
    await conn.close();
    await expect(conn.submitValidateAsync(CFG, 5)).rejects.toBeInstanceOf(
      ConnectionClosedError,
    );
    await expect(conn.queryJob("job-1")).rejects.toBeInstanceOf(ConnectionClosedError);
    await fake.close();
  });
});

describe("synchronous validate (C16)", () => {
  it("returns valid and sends a well-formed register_validate", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "register_validate")
        reply({ proto_step: "spec_validated", result: "valid" });
    });
    const result = await runClientValidate(connectMirror("127.0.0.1", fake.port), CFG, 5);
    expect(result).toBe("valid");
    expect(fake.requests[0]).toEqual({
      proto_step: "register_validate",
      apalacheConfig: { specPath: "s.tla", invariant: "Inv", lengthBound: 3 },
      bound: 5,
    });
    expect("spec" in (fake.requests[0] ?? {})).toBe(false);
    await fake.close();
  });

  it("returns the invalid payload verbatim", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "register_validate")
        reply({ proto_step: "spec_validated", result: { invalid: "Invariant violated" } });
    });
    const result = await runClientValidate(connectMirror("127.0.0.1", fake.port), CFG, 5);
    expect(result).toEqual({ invalid: "Invariant violated" });
    await fake.close();
  });

  it("register_error fails the attempt", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "register_validate")
        reply({ proto_step: "register_error", error: "apalache exploded" });
    });
    await expect(
      runClientValidate(connectMirror("127.0.0.1", fake.port), CFG, 5),
    ).rejects.toBeInstanceOf(RegisterFailedError);
    await fake.close();
  });

  it("rejects out-of-range bounds before any bytes", async () => {
    const fake = await startFakeMirror(() => {});
    await expect(
      runClientValidate(connectMirror("127.0.0.1", fake.port), CFG, 0),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fake.requests).toHaveLength(0);
    await fake.close();
  });

  it("validate consumes the session flow (C5)", async () => {
    const fake = await startFakeMirror((req, reply) => {
      if (req.proto_step === "register_validate")
        reply({ proto_step: "spec_validated", result: "valid" });
    });
    const conn = await openConn(fake.port);
    expect(await conn.validate(CFG, 5)).toBe("valid");
    await expect(conn.queryJob("job-1")).rejects.toBeInstanceOf(ConnectionClosedError);
    await expect(conn.validate(CFG, 5)).rejects.toBeInstanceOf(ConnectionClosedError);
    await conn.close();
    await fake.close();
  });
});
