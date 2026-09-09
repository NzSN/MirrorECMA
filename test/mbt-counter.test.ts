import { resolve } from "node:path";
import {
  ReplayCancelledError,
  ReplayMismatchError,
  spawnMirror,
  type AsyncAdapterFactory,
  type Transport,
} from "../src/index.js";
import { createLocalCounterFactory } from "../examples/mbt-counter/local-provider.js";
import { counterReplayInputs, runCounterSuite } from "../examples/mbt-counter/suite.js";

const inputs = counterReplayInputs(process.cwd());

test("pre-factory cancellation creates no implementation or transport", async () => {
  const controller = new AbortController();
  controller.abort("cancel before start");
  let creations = 0;
  await expect(runCounterSuite({
    ...inputs, mirror: "/not-an-executable", signal: controller.signal,
  }, async () => { creations++; throw new Error("must not create"); }))
    .rejects.toBeInstanceOf(ReplayCancelledError);
  expect(creations).toBe(0);
});

test("an unverified model never calls the implementation factory", async () => {
  let creations = 0;
  let closes = 0;
  const mirror: Transport = {
    send: () => {},
    close: async () => { closes++; return 0; },
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify({ proto_step: "spec_validated", result: "valid" });
    },
  };
  await expect(runCounterSuite({ ...inputs, mirror }, async () => {
    creations++; throw new Error("must not create");
  })).rejects.toMatchObject({ code: "negotiation_missing" });
  expect(creations).toBe(0);
  expect(closes).toBe(1);
});

// The standalone smoke requires MIRROR_BIN and exercises this real source-test tier.
const realTest = process.env.MIRROR_BIN ? test : test.skip;
const mirrorBinary = resolve(process.env.MIRROR_BIN ?? "missing-mirror");

realTest.each([false, true])("real Counter suite, broken=%s, matched before create and one disposal", async (broken) => {
  const inner = spawnMirror(mirrorBinary);
  let matched = false;
  let creations = 0;
  let disposals = 0;
  const mirror: Transport = {
    send: (line) => inner.send(line),
    close: () => inner.close(),
    async *[Symbol.asyncIterator]() {
      for await (const line of inner) {
        const message = JSON.parse(line);
        if (message.modelInterface?.status === "matched") matched = true;
        yield line;
      }
    },
  };
  const local = createLocalCounterFactory(broken);
  const factory: AsyncAdapterFactory = async (config, authority) => {
    expect(matched).toBe(true);
    expect(authority.status).toBe("matched");
    creations++;
    const binding = await local(config, authority);
    return { ...binding, dispose: async () => { disposals++; await binding.dispose(); } };
  };
  const result = runCounterSuite({ ...inputs, mirror }, factory);
  if (broken) {
    await expect(result).rejects.toMatchObject({
      code: "replay_mismatch", action: "tick", traceIndex: 0, stepIndex: 1,
      expected: { count: { tag: "int", val: 2n } },
      actual: { count: { tag: "int", val: 1n } },
    });
  } else {
    await expect(result).resolves.toMatchObject({
      status: "completed", acceptedTraces: 1, acceptedSteps: 2,
      actionCoverage: { Initialize: 1, Tick: 2 },
    });
  }
  expect(creations).toBe(1);
  expect(disposals).toBe(1);
}, 30_000);

realTest("factory failure propagates without invoking replay", async () => {
  const failure = new Error("implementation unavailable");
  await expect(runCounterSuite({ ...inputs, mirror: mirrorBinary }, async () => {
    throw failure;
  })).rejects.toMatchObject({ code: "adapter_factory_failed", cause: failure });
});

realTest("disposal failure propagates after successful conformance", async () => {
  const failure = new Error("implementation cleanup failed");
  let disposals = 0;
  const local = createLocalCounterFactory();
  await expect(runCounterSuite({ ...inputs, mirror: mirrorBinary }, async (config, authority) => ({
    ...await local(config, authority),
    dispose: () => { disposals++; throw failure; },
  }))).rejects.toMatchObject({ code: "adapter_dispose_failed", cause: failure });
  expect(disposals).toBe(1);
});

realTest("adapter errors are retained as causes and dispose once", async () => {
  const failure = new Error("implementation disconnected");
  let disposals = 0;
  const local = createLocalCounterFactory();
  await expect(runCounterSuite({ ...inputs, mirror: mirrorBinary }, async (config, authority) => ({
    ...await local(config, authority), computer: async () => { throw failure; },
    dispose: () => { disposals++; },
  }))).rejects.toBe(failure);
  expect(disposals).toBe(1);
});

realTest("a source-test entry point preserves the structured mismatch", async () => {
  // A consumer test simply awaits this expression; a faulty SUT rejects its test.
  const run = runCounterSuite({ ...inputs, mirror: mirrorBinary }, createLocalCounterFactory(true));
  await expect(run).rejects.toBeInstanceOf(ReplayMismatchError);
});

realTest("cancellation during creation disposes the late binding once", async () => {
  const controller = new AbortController();
  let enter!: () => void;
  let release!: () => void;
  let disposed!: () => void;
  const entered = new Promise<void>((resolveEntered) => { enter = resolveEntered; });
  const released = new Promise<void>((resolveReleased) => { release = resolveReleased; });
  const disposal = new Promise<void>((resolveDisposed) => { disposed = resolveDisposed; });
  let creations = 0;
  let disposals = 0;
  const local = createLocalCounterFactory();
  const run = runCounterSuite({ ...inputs, mirror: mirrorBinary, signal: controller.signal }, async (config, authority) => {
    creations++;
    enter();
    await released;
    return {
      ...await local(config, authority),
      dispose: () => { disposals++; disposed(); },
    };
  });
  // Attach a rejection observer before coordinating the deliberately pending factory.
  const rejected = expect(run).rejects.toBeInstanceOf(ReplayCancelledError);
  try {
    await entered;
    controller.abort("stop pending implementation creation");
    await rejected;
    expect(disposals).toBe(0);
  } finally { release(); }
  await disposal;
  expect(creations).toBe(1);
  expect(disposals).toBe(1);
}, 10_000);
