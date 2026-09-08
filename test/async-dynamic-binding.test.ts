import {
  bindAsyncDynamicDescriptor,
  type AsyncDynamicActionHandler,
  type AsyncDynamicBinding,
  type AsyncDynamicHandlerRegistry,
  type AsyncDynamicObservationHandler,
} from "../src/dynamic-binding.js";
import {
  MODEL_INTERFACE_COMPARISON_POLICY_VERSION,
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  MODEL_INTERFACE_RESOLVER_SEMANTICS_VERSION,
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
} from "../src/model-interface.js";
import type { ReplayContext } from "../src/replay-control.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const descriptor = decodeSemanticDescriptor({
  schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  interfaceVersion: "1.0.0",
  model: { module: "AsyncDynamicFixture" },
  resolverSemanticsVersion: MODEL_INTERFACE_RESOLVER_SEMANTICS_VERSION,
  comparisonPolicyVersion: MODEL_INTERFACE_COMPARISON_POLICY_VERSION,
  runProfile: {
    actionVariable: "action_taken", configuredParamVar: null, itfParamVars: [], effectiveParamVars: [],
  },
  initializers: [{ id: "Initialize", phase: "initialize", wireAction: "init", wireAliases: [], inputs: [] }],
  actions: [{
    id: "Tick", phase: "transition", wireAction: "tick", wireAliases: ["advance"],
    inputs: [{
      id: "Stride", from: { root: "stepParameters", path: [{ field: "stride" }] }, type: { kind: "int" },
    }],
  }],
  observations: [
    { id: "Count", wireName: "count", type: { kind: "int" }, provenance: "implementation" },
    { id: "Ready", wireName: "ready", type: { kind: "bool" }, provenance: "implementation" },
  ],
});

function context(controller = new AbortController()): ReplayContext {
  return { signal: controller.signal, traceIndex: 1, stateIndex: 0 };
}

function registry(options: {
  initialize?: AsyncDynamicActionHandler;
  tick?: AsyncDynamicActionHandler;
  count?: AsyncDynamicObservationHandler;
  ready?: AsyncDynamicObservationHandler;
} = {}): AsyncDynamicHandlerRegistry {
  return {
    semanticDigest: semanticDescriptorDigest(descriptor),
    actions: { Initialize: options.initialize ?? (() => {}), Tick: options.tick ?? (() => {}) },
    observations: { Count: options.count ?? (() => 0n), Ready: options.ready ?? (() => true) },
  };
}

describe("async dynamic descriptor binding", () => {
  it("awaits the action before one sequential observation pass and counts aliases once", async () => {
    const action = deferred<void>();
    const observer = deferred<bigint>();
    const actionEntered = deferred<void>();
    const observerEntered = deferred<void>();
    const events: string[] = [];
    const binding = bindAsyncDynamicDescriptor(descriptor, registry({
      initialize: async (inputs, invocation) => {
        expect(inputs).toEqual({});
        expect(Object.isFrozen(inputs)).toBe(true);
        expect(invocation.traceIndex).toBe(1);
        expect(invocation.signal.aborted).toBe(false);
        events.push("action:start");
        actionEntered.resolve();
        await action.promise;
        events.push("action:end");
      },
      count: async () => {
        events.push("count:start");
        observerEntered.resolve();
        const value = await observer.promise;
        events.push("count:end");
        return value;
      },
      ready: async () => { events.push("ready"); return true; },
      tick: async (inputs) => { expect(inputs.Stride).toBe(2n); events.push("tick"); },
    }));
    const pending = binding.computer("init", {}, {}, context());
    await actionEntered.promise;
    expect(events).toEqual(["action:start"]);
    action.resolve();
    await observerEntered.promise;
    expect(events).toEqual(["action:start", "action:end", "count:start"]);
    observer.resolve(3n);
    await expect(pending).resolves.toEqual({
      count: { tag: "int", val: 3n }, ready: { tag: "bool", val: true },
    });
    expect(events).toEqual(["action:start", "action:end", "count:start", "count:end", "ready"]);
    await binding.computer("advance", { stride: { tag: "int", val: 2n } }, {}, context());
    expect(binding.coverage()).toEqual({ Initialize: 1, Tick: 1 });
    expect(() => binding.assertAllActionsCovered()).not.toThrow();
  });

  it("validates all inputs before invoking a transition and poisons invalid input", async () => {
    let calls = 0;
    const binding = bindAsyncDynamicDescriptor(descriptor, registry({ tick: async () => { calls += 1; } }));
    await binding.computer("init", {}, {}, context());
    await expect(binding.computer("tick", { stride: { tag: "str", val: "bad" } }, {}, context()))
      .rejects.toMatchObject({ code: "input_shape_mismatch" });
    expect(calls).toBe(0);
    await expect(binding.computer("tick", { stride: { tag: "int", val: 1n } }, {}, context()))
      .rejects.toMatchObject({ code: "binding_poisoned" });
  });

  it("rejects an already aborted invocation without application callbacks", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const binding = bindAsyncDynamicDescriptor(descriptor, registry({ initialize: () => { calls += 1; } }));
    await expect(binding.computer("init", {}, {}, context(controller)))
      .rejects.toMatchObject({ code: "binding_aborted" });
    expect(calls).toBe(0);
    await expect(binding.computer("init", {}, {}, context()))
      .rejects.toMatchObject({ code: "binding_poisoned" });
  });

  it.each(["abort", "timeout"])("stops after %s even if the action later completes", async (kind) => {
    const action = deferred<void>();
    const entered = deferred<void>();
    const controller = new AbortController();
    let observed = 0;
    let mutation = false;
    let seenSignal: AbortSignal | undefined;
    const binding = bindAsyncDynamicDescriptor(descriptor, registry({
      initialize: async (_inputs, invocation) => {
        seenSignal = invocation.signal;
        entered.resolve();
        await action.promise;
        mutation = true;
      },
      count: () => { observed += 1; return 0n; },
    }));
    const pending = binding.computer("init", {}, {}, context(controller));
    const rejected = expect(pending).rejects.toMatchObject({ code: "binding_aborted" });
    await entered.promise;
    controller.abort(new DOMException(kind, kind === "timeout" ? "TimeoutError" : "AbortError"));
    await rejected;
    expect(seenSignal?.aborted).toBe(true);
    expect(observed).toBe(0);
    action.resolve();
    await action.promise;
    await Promise.resolve();
    expect(mutation).toBe(true); // Cancellation cannot undo non-cooperative SUT code.
    expect(observed).toBe(0);
    expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
    await expect(binding.computer("init", {}, {}, context()))
      .rejects.toMatchObject({ code: "binding_poisoned" });
  });

  it("consumes a late action rejection after cancellation", async () => {
    const action = deferred<void>();
    const controller = new AbortController();
    const binding = bindAsyncDynamicDescriptor(descriptor, registry({ initialize: () => action.promise }));
    const pending = binding.computer("init", {}, {}, context(controller));
    const rejected = expect(pending).rejects.toMatchObject({ code: "binding_aborted" });
    controller.abort();
    await rejected;
    action.reject(new Error("late action failure"));
    await Promise.resolve();
    expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
  });

  it("stops the observation pass if cancellation arrives during its first observer", async () => {
    const first = deferred<bigint>();
    const entered = deferred<void>();
    const controller = new AbortController();
    let secondCalls = 0;
    const binding = bindAsyncDynamicDescriptor(descriptor, registry({
      count: () => { entered.resolve(); return first.promise; },
      ready: () => { secondCalls += 1; return true; },
    }));
    const pending = binding.computer("init", {}, {}, context(controller));
    const rejected = expect(pending).rejects.toMatchObject({ code: "binding_aborted" });
    await entered.promise;
    controller.abort();
    await rejected;
    first.resolve(0n);
    await first.promise;
    await Promise.resolve();
    expect(secondCalls).toBe(0);
  });

  it.each(["handler", "observer", "invalid observer"])("poisons on %s failure", async (failure) => {
    let observers = 0;
    const binding = bindAsyncDynamicDescriptor(descriptor, registry({
      initialize: async () => { if (failure === "handler") throw new Error("action failed"); },
      count: async () => {
        observers += 1;
        if (failure === "observer") throw new Error("observation failed");
        return failure === "invalid observer" ? "not an integer" : 0n;
      },
    }));
    await expect(binding.computer("init", {}, {}, context())).rejects.toMatchObject({
      code: failure === "handler" ? "adapter_failure" : "observation_shape_mismatch",
    });
    if (failure === "handler") expect(observers).toBe(0);
    await expect(binding.computer("init", {}, {}, context())).rejects.toMatchObject({ code: "binding_poisoned" });
    expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
  });

  it("rejects nonvoid asynchronous action results before observing", async () => {
    let observed = 0;
    const binding = bindAsyncDynamicDescriptor(descriptor, registry({
      initialize: (async () => 1) as unknown as AsyncDynamicActionHandler,
      count: () => { observed += 1; return 0n; },
    }));
    await expect(binding.computer("init", {}, {}, context())).rejects.toMatchObject({ code: "adapter_failure" });
    expect(observed).toBe(0);
  });

  it("cannot recover when the first observer swallows a reentrant invocation error", async () => {
    let laterObservers = 0;
    let binding!: AsyncDynamicBinding;
    binding = bindAsyncDynamicDescriptor(descriptor, registry({
      count: async () => {
        try { await binding.computer("init", {}, {}, context()); } catch { /* still poisoned */ }
        return 0n;
      },
      ready: () => { laterObservers += 1; return true; },
    }));
    await expect(binding.computer("init", {}, {}, context()))
      .rejects.toMatchObject({ code: "observation_shape_mismatch" });
    expect(laterObservers).toBe(0);
    expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
  });

  it("poisons a concurrent invocation and stops the original pending action", async () => {
    const action = deferred<void>();
    let observers = 0;
    const binding = bindAsyncDynamicDescriptor(descriptor, registry({
      initialize: () => action.promise,
      count: () => { observers += 1; return 0n; },
    }));
    const first = binding.computer("init", {}, {}, context());
    const firstRejected = expect(first).rejects.toMatchObject({ code: "adapter_failure" });
    await expect(binding.computer("init", {}, {}, context())).rejects.toMatchObject({ code: "adapter_failure" });
    await firstRejected;
    action.resolve();
    await Promise.resolve();
    expect(observers).toBe(0);
  });

  it("cannot recover when an action swallows a reentrant invocation error", async () => {
    let observers = 0;
    let binding!: AsyncDynamicBinding;
    binding = bindAsyncDynamicDescriptor(descriptor, registry({
      initialize: async () => {
        try { await binding.computer("init", {}, {}, context()); } catch { /* still poisoned */ }
      },
      count: () => { observers += 1; return 0n; },
    }));
    await expect(binding.computer("init", {}, {}, context())).rejects.toMatchObject({ code: "adapter_failure" });
    expect(observers).toBe(0);
  });

  it("disposes exactly once, aborts pending work, and prohibits all later computations", async () => {
    const action = deferred<void>();
    const cleanup = deferred<void>();
    let cleanups = 0;
    let observers = 0;
    const binding = bindAsyncDynamicDescriptor(descriptor, registry({
      initialize: () => action.promise,
      count: () => { observers += 1; return 0n; },
    }), async () => { cleanups += 1; await cleanup.promise; });
    const pending = binding.computer("init", {}, {}, context());
    const rejected = expect(pending).rejects.toMatchObject({ code: "binding_disposed" });
    const first = binding.dispose();
    expect(binding.dispose()).toBe(first);
    await rejected;
    await expect(binding.computer("init", {}, {}, context())).rejects.toMatchObject({ code: "binding_disposed" });
    expect(cleanups).toBe(1);
    action.resolve();
    cleanup.resolve();
    await first;
    await Promise.resolve();
    expect(observers).toBe(0);
    expect(cleanups).toBe(1);
  });
});
