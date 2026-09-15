import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { jest } from "@jest/globals";
import { encodeClientMessage, type ApalacheConfig, type TraceGenerationConfig } from "../src/protocol.js";

const apalacheConfig: ApalacheConfig = {
  specPath: "Spec.tla",
  invariant: "Inv",
  lengthBound: 1,
};
const traceConfig: TraceGenerationConfig = { numTraces: 1 };

function oversizedSpec(): { sources: string[] } {
  return { sources: [`---- MODULE Huge ----\n${"x".repeat(70_000)}\n====`] };
}

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  written: string;
  kill: () => boolean;
}

const spawnCalls: unknown[][] = [];
const spawned: FakeChild[] = [];

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.written = "";
  child.kill = () => true;
  child.stdin.on("data", (chunk: Buffer) => { child.written += chunk.toString("utf8"); });
  child.stdin.on("finish", () => { queueMicrotask(() => child.emit("close", 0)); });
  return child;
}

jest.unstable_mockModule("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    spawnCalls.push(args);
    const child = fakeChild();
    spawned.push(child);
    child.stdin.once("data", () => {
      child.stdout.write(JSON.stringify({
        proto_step: "gen_traces_done",
        itfTracePaths: [],
        itfTraces: [],
      }) + "\n");
    });
    return child;
  },
}));

const { runClientExplore, runClientGenTraces } = await import("../src/client.js");

describe("spawn allocation on registration", () => {
  jest.setTimeout(20_000);

  beforeEach(() => {
    spawnCalls.length = 0;
    spawned.length = 0;
  });

  it("allocates no child for an oversized trace-generation registration", async () => {
    await expect(
      runClientGenTraces("mirror-bin", apalacheConfig, null, traceConfig, { spec: oversizedSpec() }),
    ).rejects.toThrow(/UTF-8 bytes/);
    expect(spawnCalls).toHaveLength(0);
  });

  it("allocates no child for an oversized exploration registration", async () => {
    await expect(
      runClientExplore("mirror-bin", oversizedSpec(), [], [], 1, () => {
        throw new Error("client computer must not run");
      }),
    ).rejects.toThrow(/UTF-8 bytes/);
    expect(spawnCalls).toHaveLength(0);
  });

  it("still allocates and closes one child for an in-limit registration", async () => {
    const result = await runClientGenTraces("mirror-bin", apalacheConfig, null, traceConfig);
    expect(result).toEqual({ itfTracePaths: [], itfTraces: [] });
    expect(spawnCalls).toHaveLength(1);
    expect(spawned[0]!.written).toBe(encodeClientMessage({
      proto_step: "register_trace_gen",
      apalacheConfig,
      traceConfig,
      destPath: null,
      spec: undefined,
    }) + "\n");
    expect(spawned[0]!.stdin.writableEnded).toBe(true);
  });
});
