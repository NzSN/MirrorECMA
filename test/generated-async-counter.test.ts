import {
  bindCounterAsync,
  bindCounterAsyncPublicPort,
  CounterAsyncStateComputerContractVersion,
  CounterAsyncTargetProfile,
  CounterPublicManifest,
  type CounterAsyncBinding,
  type CounterAsyncPort,
} from "./fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";
import {
  invokeAsyncComputer,
  type ReplayContext,
  type ReplayInput,
} from "../src/async-replay.js";
import type { State } from "../src/protocol.js";

function state(fields: State = Object.create(null) as State): State {
  return fields;
}

function input(action: string, payload: State = state()): ReplayInput {
  return { action, payload, previous: state() };
}

function context(controller = new AbortController(), offsetMs = 10_000): ReplayContext {
  return { signal: controller.signal, deadline: performance.now() + offsetMs };
}

function tickPayload(stride: bigint): State {
  return state({
    parameters: {
      tag: "record",
      val: { stride: { tag: "int", val: stride } },
    },
  });
}

describe("generated mirrorecma-async-v1 Counter binding", () => {
  test("records one ordered action and observation per successful step", async () => {
    const events: string[] = [];
    let count = 0n;
    const seenContexts: ReplayContext[] = [];
    const port: CounterAsyncPort = {
      initialize: async (ctx) => {
        events.push("action:Initialize");
        seenContexts.push(ctx);
        count = 0n;
      },
      tick: async ({ stride }, ctx) => {
        events.push(`action:Tick:${stride}`);
        seenContexts.push(ctx);
        count += stride;
      },
      observe: async (ctx) => {
        events.push(`observe:${count}`);
        seenContexts.push(ctx);
        return { count };
      },
    };
    const binding = bindCounterAsync(port, { paramVars: "parameters" });
    const firstContext = context();
    await expect(binding.computer(input("init"), firstContext)).resolves.toEqual({
      count: { tag: "int", val: 0n },
    });
    const secondContext = context();
    await expect(binding.computer(input("tick", tickPayload(2n)), secondContext)).resolves.toEqual({
      count: { tag: "int", val: 2n },
    });
    expect(events).toEqual([
      "action:Initialize",
      "observe:0",
      "action:Tick:2",
      "observe:2",
    ]);
    expect(seenContexts).toEqual([
      firstContext,
      firstContext,
      secondContext,
      secondContext,
    ]);
    expect(binding.coverage()).toEqual({ Initialize: 1, Tick: 1 });
    expect(() => binding.assertAllActionsCovered()).not.toThrow();
  });

  test("maps the generic public port through stable IDs without model wire fields", async () => {
    const calls: Array<readonly [string, Readonly<Record<string, unknown>>, ReplayContext]> = [];
    let count = 0n;
    const binding = bindCounterAsyncPublicPort({
      invoke: async (operationId, inputs, ctx) => {
        calls.push([operationId, inputs, ctx]);
        if (operationId === "Initialize") count = 0n;
        else count += inputs.Stride as bigint;
      },
      observe: async () => ({ Count: count }),
    }, { paramVars: "parameters" });
    const initializeContext = context();
    const tickContext = context();
    await binding.computer(input("init"), initializeContext);
    await binding.computer(input("tick", tickPayload(3n)), tickContext);
    expect(calls).toEqual([
      ["Initialize", {}, initializeContext],
      ["Tick", { Stride: 3n }, tickContext],
    ]);
    expect(binding.coverage()).toEqual({ Initialize: 1, Tick: 1 });
    expect(() => binding.assertCompatibleConfig({ paramVars: "wrong" })).toThrow(
      expect.objectContaining({ code: "configuration_mismatch" }),
    );
  });

  test("classifies synchronous callback throws and rejected callbacks, then poisons", async () => {
    for (const initialize of [
      () => { throw new Error("start failed"); },
      () => Promise.reject(new Error("rejected callback")),
    ]) {
      const binding = bindCounterAsync({
        initialize,
        tick: async () => undefined,
        observe: async () => ({ count: 0n }),
      }, { paramVars: "parameters" });
      await expect(binding.computer(input("init"), context())).rejects.toMatchObject({
        code: "adapter_failure",
      });
      await expect(binding.computer(input("init"), context())).rejects.toMatchObject({
        code: "binding_poisoned",
      });
      expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
    }
  });

  test("cancellation of a pending action never observes or reports a late completion", async () => {
    let releaseTick!: () => void;
    let observations = 0;
    let count = 0n;
    const port: CounterAsyncPort = {
      initialize: async () => { count = 0n; },
      tick: async ({ stride }) => {
        await new Promise<void>((resolve) => { releaseTick = resolve; });
        count += stride;
      },
      observe: async () => {
        observations += 1;
        return { count };
      },
    };
    const binding = bindCounterAsync(port, { paramVars: "parameters" });
    await binding.computer(input("init"), context());
    const controller = new AbortController();
    const pending = binding.computer(input("tick", tickPayload(2n)), context(controller));
    await Promise.resolve();
    controller.abort(new Error("cancel test"));
    await expect(pending).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(observations).toBe(1);
    expect(binding.coverage()).toEqual({ Initialize: 1, Tick: 0 });
    releaseTick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observations).toBe(1);
    expect(binding.coverage()).toEqual({ Initialize: 1, Tick: 0 });
    await expect(binding.computer(input("tick", tickPayload(1n)), context())).rejects.toMatchObject({
      code: "binding_poisoned",
    });
  });

  test("a caught nested call still poisons the outer call across its await", async () => {
    let binding!: CounterAsyncBinding;
    let observations = 0;
    const port: CounterAsyncPort = {
      initialize: async () => undefined,
      tick: async (_input, ctx) => {
        await expect(binding.computer(input("init"), ctx)).rejects.toMatchObject({
          code: "reentrant_call",
        });
      },
      observe: async () => {
        observations += 1;
        return { count: 0n };
      },
    };
    binding = bindCounterAsync(port, { paramVars: "parameters" });
    await binding.computer(input("init"), context());
    await expect(binding.computer(input("tick", tickPayload(1n)), context())).rejects.toMatchObject({
      code: "binding_poisoned",
    });
    expect(observations).toBe(1);
    expect(binding.coverage()).toEqual({ Initialize: 1, Tick: 0 });
  });

  test("reentry from an observation getter cannot increment coverage or return state", async () => {
    let binding!: CounterAsyncBinding;
    let nested: Promise<State> | undefined;
    const port: CounterAsyncPort = {
      initialize: async () => undefined,
      tick: async () => undefined,
      observe: async () => {
        const observation = Object.create(null) as { count: bigint };
        Object.defineProperty(observation, "count", {
          enumerable: true,
          get: () => {
            nested = binding.computer(input("init"), context());
            void nested.catch(() => undefined);
            return 0n;
          },
        });
        return observation;
      },
    };
    binding = bindCounterAsync(port, { paramVars: "parameters" });
    await expect(binding.computer(input("init"), context())).rejects.toMatchObject({
      code: "binding_poisoned",
    });
    await expect(nested).rejects.toMatchObject({ code: "reentrant_call" });
    expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
  });

  test("rejects an expired monotonic deadline before invoking the port", async () => {
    let calls = 0;
    const binding = bindCounterAsync({
      initialize: async () => { calls += 1; },
      tick: async () => { calls += 1; },
      observe: async () => { calls += 1; return { count: 0n }; },
    }, { paramVars: "parameters" });
    await expect(binding.computer(input("init"), {
      signal: new AbortController().signal,
      deadline: performance.now() - 1,
    })).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(calls).toBe(0);
  });

  test("the replay driver retains its timeout error when a port action never settles", async () => {
    const binding = bindCounterAsync({
      initialize: () => new Promise<void>(() => undefined),
      tick: async () => undefined,
      observe: async () => ({ count: 0n }),
    }, { paramVars: "parameters" });
    await expect(invokeAsyncComputer(binding.computer, input("init"), undefined, 5))
      .rejects.toMatchObject({ name: "ReplayDeadlineError", code: "replay_deadline_exceeded" });
    expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
  });

  test("the standalone generated binding enforces its monotonic deadline", async () => {
    const binding = bindCounterAsync({
      initialize: () => new Promise<void>(() => undefined),
      tick: async () => undefined,
      observe: async () => ({ count: 0n }),
    }, { paramVars: "parameters" });
    await expect(binding.computer(input("init"), {
      signal: new AbortController().signal,
      deadline: performance.now() + 5,
    })).rejects.toMatchObject({ name: "CounterBindingError", code: "deadline_exceeded" });
    expect(binding.coverage()).toEqual({ Initialize: 0, Tick: 0 });
  });

  test("exports stable async identities and a sanitized public manifest", () => {
    expect(CounterAsyncTargetProfile).toBe("mirrorecma-async-v1");
    expect(CounterAsyncStateComputerContractVersion).toBe("mirrors.async-state-computer/v1");
    expect(CounterPublicManifest).toEqual({
      schema: "mirrorgate.port/v1",
      interfaceDigest: "193d6cc187d05c18f02ad483a44f8ad0c1634b02083df241df08b9281b045d1c",
      initializers: [{ id: "Initialize", inputs: [] }],
      actions: [{ id: "Tick", inputs: [{ id: "Stride", type: { kind: "int" } }] }],
      observations: [{ id: "Count", type: { kind: "int" } }],
    });
    expect(JSON.stringify(CounterPublicManifest)).not.toMatch(
      /wireAction|wireName|projection|parameters|specs\/Counter|provenance/,
    );
  });
});
