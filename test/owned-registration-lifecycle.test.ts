import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jest } from "@jest/globals";
import { runClientExplore, runClientGenTraces } from "../src/client.js";
import { encodeClientMessage, type ApalacheConfig, type TraceGenerationConfig } from "../src/protocol.js";
import { replayReportFromError } from "../src/replay-report.js";
import type { Transport } from "../src/transport.js";

const apalacheConfig: ApalacheConfig = {
  specPath: "Spec.tla",
  invariant: "Inv",
  lengthBound: 1,
};
const traceConfig: TraceGenerationConfig = { numTraces: 1 };
const BLOCKING_MIRROR = resolve("test/fixtures/blocking-mirror.mjs");

function oversizedSpec(): { sources: string[] } {
  return { sources: [`---- MODULE Huge ----\n${"x".repeat(70_000)}\n====`] };
}

async function waitForPidFile(path: string, timeoutMs = 2_000): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8").trim();
      if (text.length > 0) return Number(text);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return undefined;
}

function killReproChild(pid: number | undefined): void {
  if (pid === undefined || !Number.isFinite(pid)) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
}

function oversizedRegistrationBytes(protoStep: "register_trace_gen" | "register_explore"): number {
  const line = protoStep === "register_trace_gen"
    ? encodeClientMessage({
        proto_step: "register_trace_gen",
        apalacheConfig,
        traceConfig,
        destPath: null,
        spec: oversizedSpec(),
      })
    : encodeClientMessage({
        proto_step: "register_explore",
        spec: oversizedSpec(),
        invariants: [],
        exports: [],
        maxSteps: 1,
      });
  return Buffer.byteLength(line, "utf8");
}

interface ScriptedTransport extends Transport {
  readonly sent: string[];
  readonly closeCount: number;
}

function scriptedTransport(options: {
  send?: (line: string, sent: string[]) => void;
  replies?: string[];
  close?: () => Promise<number>;
  iterator?: () => AsyncIterator<string>;
} = {}): ScriptedTransport {
  const sent: string[] = [];
  const replies = [...(options.replies ?? [])];
  let closeCount = 0;
  return {
    sent,
    get closeCount() { return closeCount; },
    send(line: string) {
      if (options.send) options.send(line, sent);
      sent.push(line);
    },
    close() {
      closeCount += 1;
      return options.close ? options.close() : Promise.resolve(0);
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      if (options.iterator) return options.iterator();
      return {
        next() {
          const value = replies.shift();
          return Promise.resolve(value === undefined
            ? { done: true, value: undefined }
            : { done: false, value });
        },
      };
    },
  };
}

const GEN_TRACES_DONE = JSON.stringify({
  proto_step: "gen_traces_done",
  itfTracePaths: [],
  itfTraces: [],
});
const SPEC_VALIDATED = JSON.stringify({ proto_step: "spec_validated", result: "valid" });
const ALL_STEPS_DONE = JSON.stringify({ proto_step: "all_steps_done" });

describe("owned registration lifecycle", () => {
  jest.setTimeout(20_000);

  it("runClientGenTraces validates before spawning an owned child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirrorecma-gen-leak-"));
    const pidFile = join(dir, "child.pid");
    const previous = process.env.MIRROR_PID_FILE;
    process.env.MIRROR_PID_FILE = pidFile;
    let pid: number | undefined;
    try {
      expect(oversizedRegistrationBytes("register_trace_gen")).toBe(70_209);
      await expect(runClientGenTraces(
        BLOCKING_MIRROR, apalacheConfig, null, traceConfig,
        { spec: oversizedSpec() },
      )).rejects.toThrow(/UTF-8 bytes/);
      pid = await waitForPidFile(pidFile);
      if (pid !== undefined) expect(() => process.kill(pid!, 0)).not.toThrow();
      expect(pid).toBeUndefined();
    } finally {
      killReproChild(pid);
      if (previous === undefined) delete process.env.MIRROR_PID_FILE;
      else process.env.MIRROR_PID_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runClientExplore validates before spawning an owned child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirrorecma-explore-leak-"));
    const pidFile = join(dir, "child.pid");
    const previous = process.env.MIRROR_PID_FILE;
    process.env.MIRROR_PID_FILE = pidFile;
    let pid: number | undefined;
    try {
      expect(oversizedRegistrationBytes("register_explore")).toBe(70_128);
      await expect(runClientExplore(
        BLOCKING_MIRROR, oversizedSpec(), [], [], 1,
        () => { throw new Error("client computer must not run"); },
      )).rejects.toThrow(/UTF-8 bytes/);
      pid = await waitForPidFile(pidFile);
      if (pid !== undefined) expect(() => process.kill(pid!, 0)).not.toThrow();
      expect(pid).toBeUndefined();
    } finally {
      killReproChild(pid);
      if (previous === undefined) delete process.env.MIRROR_PID_FILE;
      else process.env.MIRROR_PID_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an oversized registration before touching a caller-supplied transport", async () => {
    const transport = scriptedTransport();
    await expect(
      runClientGenTraces(transport, apalacheConfig, null, traceConfig, {
        spec: oversizedSpec(),
      }),
    ).rejects.toThrow(/UTF-8 bytes/);
    expect(transport.sent).toHaveLength(0);
    expect(transport.closeCount).toBe(0);
  });

  it("rejects an oversized exploration before touching a caller-supplied transport", async () => {
    const transport = scriptedTransport();
    await expect(
      runClientExplore(transport, oversizedSpec(), [], [], 1, () => {
        throw new Error("client computer must not run");
      }),
    ).rejects.toThrow(/UTF-8 bytes/);
    expect(transport.sent).toHaveLength(0);
    expect(transport.closeCount).toBe(0);
  });

  it("closes exactly once and keeps the send error primary when send throws", async () => {
    const sendError = new Error("send boom");
    const transport = scriptedTransport({ send: () => { throw sendError; } });
    await expect(
      runClientGenTraces(transport, apalacheConfig, null, traceConfig),
    ).rejects.toBe(sendError);
    expect(transport.closeCount).toBe(1);
  });

  it("keeps the send error primary when cleanup also fails", async () => {
    const sendError = new Error("send boom");
    const closeError = new Error("close boom");
    const transport = scriptedTransport({
      send: () => { throw sendError; },
      close: () => Promise.reject(closeError),
    });
    await expect(
      runClientGenTraces(transport, apalacheConfig, null, traceConfig),
    ).rejects.toBe(sendError);
    expect(transport.closeCount).toBe(1);
  });

  it.each(["trace generation", "exploration"])(
    "closes once and keeps an iterator acquisition error primary for %s",
    async (operation) => {
      const iteratorError = new Error("iterator boom");
      const transport = scriptedTransport({
        iterator: () => { throw iteratorError; },
        close: () => Promise.reject(new Error("close boom")),
      });
      const result = operation === "trace generation"
        ? runClientGenTraces(transport, apalacheConfig, null, traceConfig)
        : runClientExplore(
            transport,
            { sources: ["---- MODULE Small ----\n===="] },
            [],
            [],
            1,
            () => { throw new Error("client computer must not run"); },
          );
      await expect(result).rejects.toBe(iteratorError);
      expect(transport.sent).toHaveLength(0);
      expect(transport.closeCount).toBe(1);
    },
  );

  it("closes once and keeps the send error primary for exploration", async () => {
    const sendError = new Error("send boom");
    const transport = scriptedTransport({ send: () => { throw sendError; } });
    await expect(
      runClientExplore(transport, { sources: ["---- MODULE Small ----\n===="] }, [], [], 1, () => {
        throw new Error("client computer must not run");
      }),
    ).rejects.toBe(sendError);
    expect(transport.closeCount).toBe(1);
  });

  it("reports cleanup failure when the exchange succeeded", async () => {
    const closeError = new Error("close boom");
    const transport = scriptedTransport({
      replies: [GEN_TRACES_DONE],
      close: () => Promise.reject(closeError),
    });
    await expect(
      runClientGenTraces(transport, apalacheConfig, null, traceConfig),
    ).rejects.toBe(closeError);
    expect(transport.closeCount).toBe(1);
  });

  it("closes once after a receive/decode failure", async () => {
    const transport = scriptedTransport({ replies: ["not json"] });
    await expect(
      runClientGenTraces(transport, apalacheConfig, null, traceConfig),
    ).rejects.toThrow();
    expect(transport.closeCount).toBe(1);
  });

  it("keeps an exploration application failure primary over cleanup", async () => {
    const applicationError = new Error("computer boom");
    const transport = scriptedTransport({
      replies: [
        SPEC_VALIDATED,
        JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
      ],
      close: () => Promise.reject(new Error("close boom")),
    });
    await expect(
      runClientExplore(
        transport,
        { sources: ["---- MODULE Small ----\n===="] },
        [],
        [],
        1,
        () => { throw applicationError; },
      ),
    ).rejects.toBe(applicationError);
    expect(transport.closeCount).toBe(1);
  });

  it("preserves successful exploration bytes and reports cleanup failure", async () => {
    const closeError = new Error("close boom");
    const spec = { sources: ["---- MODULE Small ----\n===="] };
    const transport = scriptedTransport({
      replies: [SPEC_VALIDATED, ALL_STEPS_DONE],
      close: () => Promise.reject(closeError),
    });
    await expect(
      runClientExplore(transport, spec, ["Inv"], ["View"], 3, () => ({})),
    ).rejects.toBe(closeError);
    expect(replayReportFromError(closeError)).toMatchObject({
      schema: "mirrorecma.replay-report/v1",
      status: "failed",
      failure: { message: "close boom" },
    });
    expect(transport.sent).toEqual([encodeClientMessage({
      proto_step: "register_explore",
      spec,
      invariants: ["Inv"],
      exports: ["View"],
      maxSteps: 3,
    })]);
    expect(transport.closeCount).toBe(1);
  });

  it("keeps readiness failure primary and closes exactly once", async () => {
    const readinessError = new Error("not ready");
    const transport = Object.assign(scriptedTransport({
      close: () => Promise.reject(new Error("close boom")),
    }), { ready: Promise.reject(readinessError) });
    await expect(
      runClientGenTraces(transport, apalacheConfig, null, traceConfig),
    ).rejects.toBe(readinessError);
    expect(transport.sent).toHaveLength(0);
    expect(transport.closeCount).toBe(1);
  });

  it("keeps the in-limit registration bytes unchanged and closes once", async () => {
    const transport = scriptedTransport({ replies: [GEN_TRACES_DONE] });
    const result = await runClientGenTraces(transport, apalacheConfig, null, traceConfig);
    expect(result).toEqual({ itfTracePaths: [], itfTraces: [] });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toBe(encodeClientMessage({
      proto_step: "register_trace_gen",
      apalacheConfig,
      traceConfig,
      destPath: null,
      spec: undefined,
    }));
    expect(transport.closeCount).toBe(1);
  });

  it("returns durable path-only success without inventing inline traces", async () => {
    const paths = ["/shared/generated/trace-0.itf.json"];
    const transport = scriptedTransport({
      replies: [JSON.stringify({
        proto_step: "gen_traces_done",
        itfTracePaths: paths,
        itfTraces: [],
      })],
    });
    const result = await runClientGenTraces(
      transport,
      apalacheConfig,
      "/shared/generated",
      traceConfig,
    );
    expect(result).toEqual({ itfTracePaths: paths, itfTraces: [] });
    expect(transport.closeCount).toBe(1);
  });
});
