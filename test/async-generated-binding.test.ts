import {
  bindCounterAsync as bindCounter, type CounterAsyncBinding as CounterBinding, type CounterAsyncPort as CounterPort,
} from "./fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";
import type { ReplayContext } from "../src/async-replay.js";
import type { State } from "../src/protocol.js";

const config = { paramVars: "parameters" };
const tickInput: State = { parameters: { tag: "record", val: { stride: { tag: "int", val: 2n } } } };

function context(controller = new AbortController(), _stateIndex = 0): ReplayContext {
  return { signal: controller.signal, deadline: performance.now() + 10_000 };
}

function compute(binding: CounterBinding, action: string, payload: State, previous: State, ctx: ReplayContext) {
  return binding.computer({ action, payload, previous }, ctx);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function port(overrides: Partial<CounterPort> = {}): CounterPort {
  return { initialize: async () => {}, tick: async () => {}, observe: async () => ({ count: 0n }), ...overrides };
}

test("generated async binding awaits initialization and tick before observing typed state", async () => {
  const initStarted = deferred<void>();
  const initComplete = deferred<void>();
  const tickStarted = deferred<void>();
  const tickComplete = deferred<void>();
  const events: string[] = [];
  let count = -1n;
  const binding = bindCounter(port({
    initialize: async (ctx) => {
      expect(ctx.deadline).toBeGreaterThan(performance.now());
      initStarted.resolve();
      await initComplete.promise;
      count = 0n;
      events.push("initialized");
    },
    tick: async ({ stride }, ctx) => {
      expect(ctx.deadline).toBeGreaterThan(performance.now());
      tickStarted.resolve();
      await tickComplete.promise;
      count += stride;
      events.push("incremented");
    },
    observe: async () => { events.push("observed"); return { count }; },
  }), config);
  const init = compute(binding, "init", {}, {}, context());
  await initStarted.promise;
  expect(events).toEqual([]);
  initComplete.resolve();
  const initial = await init;
  expect(initial).toEqual({ count: { tag: "int", val: 0n } });
  const tick = compute(binding, "tick", tickInput, initial, context(undefined, 1));
  await tickStarted.promise;
  expect(events).toEqual(["initialized", "observed"]);
  tickComplete.resolve();
  await expect(tick).resolves.toEqual({ count: { tag: "int", val: 2n } });
  expect(events).toEqual(["initialized", "observed", "incremented", "observed"]);
  expect(binding.coverage()).toEqual({ Initialize: 1, Tick: 1 });
  expect(() => binding.assertAllActionsCovered()).not.toThrow();
});

test.each(["initialize", "tick", "observe"] as const)("rejected %s poisons future computations", async (method) => {
  const failure = new Error(`${method} failed`);
  const sut = port();
  const binding = bindCounter(sut, config);
  if (method === "tick") await compute(binding, "init", {}, {}, context());
  sut[method] = async () => { throw failure; };
  await expect(compute(binding, method === "tick" ? "tick" : "init", tickInput, {}, context()))
    .rejects.toMatchObject({ code: method === "observe" ? "observation_shape_mismatch" : "adapter_failure", cause: failure });
  await expect(compute(binding, "init", {}, {}, context())).rejects.toMatchObject({ code: "binding_poisoned" });
  expect(binding.coverage()).toEqual({ Initialize: method === "tick" ? 1 : 0, Tick: 0 });
});

test("cancellation while awaiting an action prevents late observation", async () => {
  const started = deferred<void>();
  const completed = deferred<void>();
  const controller = new AbortController();
  let observed = 0;
  const binding = bindCounter(port({
    initialize: async () => { started.resolve(); await completed.promise; },
    observe: async () => { observed += 1; return { count: 0n }; },
  }), config);
  const running = compute(binding, "init", {}, {}, context(controller));
  await started.promise;
  const reason = new Error("cancelled");
  controller.abort(reason);
  completed.resolve();
  await expect(running).rejects.toMatchObject({ code: "operation_cancelled", cause: reason });
  expect(observed).toBe(0);
  expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
  await expect(compute(binding, "init", {}, {}, context())).rejects.toMatchObject({ code: "binding_poisoned" });
});

test.each(["initialize", "observe"] as const)("swallowed reentrancy in %s cannot restore the outer invocation", async (method) => {
  let binding!: CounterBinding;
  let observations = 0;
  const reenter = async () => {
    await expect(compute(binding, "init", {}, {}, context())).rejects.toMatchObject({ code: "reentrant_call" });
  };
  binding = bindCounter(port({
    initialize: async () => { if (method === "initialize") await reenter(); },
    observe: async () => {
      observations += 1;
      if (method === "observe") await reenter();
      return { count: 0n };
    },
  }), config);
  await expect(compute(binding, "init", {}, {}, context())).rejects.toMatchObject({ code: "binding_poisoned" });
  expect(observations).toBe(method === "observe" ? 1 : 0);
  expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
});

test("swallowed reentrancy in an observation getter cannot return a successful state", async () => {
  let binding!: CounterBinding;
  let nested: Promise<State> | undefined;
  binding = bindCounter(port({ observe: async () => ({
    get count() {
      nested = compute(binding, "init", {}, {}, context());
      void nested.catch(() => {});
      return 0n;
    },
  }) }), config);
  await expect(compute(binding, "init", {}, {}, context())).rejects.toMatchObject({ code: "binding_poisoned" });
  await expect(nested).rejects.toMatchObject({ code: "reentrant_call" });
  expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
});

test.each(["action", "observation"] as const)("cancelling an owned scope during %s blocks continuation and future work", async (stage) => {
  const controller = new AbortController();
  const started = deferred<void>();
  const completed = deferred<void>();
  let observations = 0;
  const wait = async () => { started.resolve(); await completed.promise; };
  const binding = bindCounter(port({
    initialize: async () => { if (stage === "action") await wait(); },
    observe: async () => {
      observations += 1;
      if (stage === "observation") await wait();
      return { count: 0n };
    },
  }), config);
  const running = compute(binding, "init", {}, {}, context(controller));
  await started.promise;
  controller.abort();
  controller.abort();
  completed.resolve();
  await expect(running).rejects.toMatchObject({ code: "operation_cancelled" });
  await expect(compute(binding, "init", {}, {}, context())).rejects.toMatchObject({ code: "binding_poisoned" });
  expect(observations).toBe(stage === "action" ? 0 : 1);
  expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
});
