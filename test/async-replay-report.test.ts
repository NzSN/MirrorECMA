import {
  ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
  AsyncCompiledAdapterRegistry,
  CompiledAdapterRegistry,
  MIRRORECMA_ASYNC_TARGET_PROFILE,
  MIRRORECMA_TARGET_PROFILE,
  ModelInterfaceRegistrationError,
  STATE_COMPUTER_CONTRACT_VERSION,
  runClientNegotiatedWithReport,
  runClientWithTracesNegotiatedWithReport,
  type AsyncCompiledExecutionSelection,
  type SyncCompiledExecutionSelection,
} from "../src/negotiated.js";
import {
  ReplayCancelledError,
  ReplayDeadlineError,
} from "../src/async-replay.js";
import {
  ReplayMismatchError,
  ReplayThrownValueError,
  replayCleanupFailure,
} from "../src/replay-report.js";
import {
  MODEL_INTERFACE_CONTRACT_SCHEMA,
  semanticDigestFromHex,
  type GeneratedModelInterface,
} from "../src/model-interface.js";
import type { ApalacheConfig, State } from "../src/protocol.js";
import type { Transport } from "../src/transport.js";

const DIGEST_HEX = "9".repeat(64);
const DIGEST = semanticDigestFromHex(DIGEST_HEX);
const CONFIG: ApalacheConfig = { specPath: "counter.tla", invariant: "Inv", lengthBound: 4 };
const METADATA: GeneratedModelInterface = {
  semanticDigest: DIGEST_HEX,
  contract: {
    schema: MODEL_INTERFACE_CONTRACT_SCHEMA,
    interfaceVersion: "1.0.0",
    model: { module: "Counter", source: "counter.tla" },
    wire: { actionVariable: "action_taken", parameterVariable: null },
    initializers: [],
    actions: [],
    observations: [],
  },
};

function matched(): string {
  return JSON.stringify({
    proto_step: "spec_validated",
    result: "valid",
    modelInterface: {
      schema: "mirrors.model-interface-negotiation/v1",
      status: "matched",
      descriptorSchema: "mirrors.model-interface-descriptor/v1",
      semanticDigest: `sha256:${DIGEST_HEX}`,
    },
  });
}

class ControlledTransport implements Transport {
  readonly sent: string[] = [];
  closes = 0;
  pulls = 0;
  private offset = 0;
  private waiter: ((value: IteratorResult<string>) => void) | undefined;

  constructor(
    private readonly replies: readonly string[],
    private readonly hooks: {
      readonly beforePull?: (index: number) => void;
      readonly iteratorError?: Error;
    } = {},
  ) {}

  send(line: string): void { this.sent.push(line); }
  async close(): Promise<number> {
    this.closes += 1;
    this.waiter?.({ value: "", done: true });
    this.waiter = undefined;
    return 0;
  }
  [Symbol.asyncIterator](): AsyncIterator<string> {
    if (this.hooks.iteratorError !== undefined) throw this.hooks.iteratorError;
    return {
      next: async () => {
        this.pulls += 1;
        this.hooks.beforePull?.(this.pulls - 1);
        if (this.offset < this.replies.length) {
          return { value: this.replies[this.offset++]!, done: false };
        }
        return new Promise<IteratorResult<string>>((resolve) => { this.waiter = resolve; });
      },
    };
  }
}

function asyncSelection(options: {
  computer?: () => Promise<State>;
  dispose?: () => void | Promise<void>;
  coverage?: () => Readonly<Record<string, number>> | Promise<Readonly<Record<string, number>>>;
} = {}): { selection: AsyncCompiledExecutionSelection; calls: string[] } {
  const calls: string[] = [];
  const registry = new AsyncCompiledAdapterRegistry([{
    key: {
      semanticDigest: DIGEST,
      adapterId: "counter",
      targetProfile: MIRRORECMA_ASYNC_TARGET_PROFILE,
      stateComputerContractVersion: ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
    },
    factory: async (_config, authority) => {
      calls.push("factory");
      expect(Object.isFrozen(authority)).toBe(true);
      expect(Object.isFrozen(authority.witness)).toBe(true);
      expect(authority.registrationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(authority.context.deadline).toBeGreaterThan(performance.now());
      return {
        semanticDigest: DIGEST,
        computer: async () => {
          calls.push("computer");
          return options.computer?.() ?? {};
        },
        assertCompatibleConfig: async () => { calls.push("config"); },
        coverage: options.coverage,
        dispose: async () => { calls.push("dispose"); await options.dispose?.(); },
      };
    },
  }]);
  return {
    selection: {
      execution: "async",
      metadata: METADATA,
      adapterId: "counter",
      targetProfile: MIRRORECMA_ASYNC_TARGET_PROFILE,
      stateComputerContractVersion: ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
      registry,
      policy: "require",
    },
    calls,
  };
}

function syncSelection(compute: () => State): SyncCompiledExecutionSelection {
  return {
    execution: "sync",
    metadata: METADATA,
    adapterId: "counter",
    targetProfile: MIRRORECMA_TARGET_PROFILE,
    stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
    registry: new CompiledAdapterRegistry([{
      key: {
        semanticDigest: DIGEST,
        adapterId: "counter",
        targetProfile: MIRRORECMA_TARGET_PROFILE,
        stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
      },
      factory: () => ({
        semanticDigest: DIGEST,
        computer: compute,
        assertCompatibleConfig: () => {},
        dispose: () => {},
      }),
    }]),
  };
}

describe("async negotiated replay reports", () => {
  it("runs one async callback at a time and returns stable coverage", async () => {
    const transport = new ControlledTransport([
      matched(),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
      JSON.stringify({ proto_step: "next_step", action: "tick", parameters: {} }),
      JSON.stringify({ proto_step: "all_steps_done" }),
    ]);
    const run = asyncSelection({ coverage: async () => ({ Tick: 1, Initialize: 1 }) });
    const report = await runClientWithTracesNegotiatedWithReport(
      transport,
      CONFIG,
      ["trace.itf.json"],
      run.selection,
    );
    expect(report).toEqual({
      status: "completed",
      acceptedTraces: 1,
      acceptedSteps: 1,
      actionCoverage: { Initialize: 1, Tick: 1 },
      diagnostics: [],
    });
    expect(run.calls).toEqual(["factory", "config", "computer", "computer", "dispose"]);
    expect(transport.sent.filter((line) => line.includes("report_state"))).toHaveLength(2);
    expect(transport.closes).toBe(1);
  });

  it("does not read or dispatch a queued initial state after a bad first reply", async () => {
    const transport = new ControlledTransport([
      JSON.stringify({ proto_step: "spec_validated", result: "valid" }),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
    ]);
    const run = asyncSelection();
    await expect(runClientWithTracesNegotiatedWithReport(
      transport, CONFIG, ["trace"], run.selection,
    )).rejects.toMatchObject({ code: "negotiation_missing" });
    expect(run.calls).toEqual([]);
    expect(transport.pulls).toBe(1);
    expect(transport.sent.some((line) => line.includes("report_state"))).toBe(false);
  });

  it("keeps raw model registration failure distinct from application failure", async () => {
    const transport = new ControlledTransport([
      JSON.stringify({ proto_step: "register_error", error: "invalid model" }),
    ]);
    const run = asyncSelection();
    const error = await runClientWithTracesNegotiatedWithReport(
      transport, CONFIG, ["trace"], run.selection,
    ).catch((cause) => cause);
    expect(error).toBeInstanceOf(ModelInterfaceRegistrationError);
    expect(error).toMatchObject({ code: "register_error", status: "register_error" });
    expect(run.calls).toEqual([]);
  });

  it("closes a silent registration when cancelled", async () => {
    const transport = new ControlledTransport([]);
    const run = asyncSelection();
    const controller = new AbortController();
    const promise = runClientWithTracesNegotiatedWithReport(
      transport,
      CONFIG,
      ["trace"],
      run.selection,
      { signal: controller.signal },
    );
    controller.abort("stop");
    await expect(promise).rejects.toBeInstanceOf(ReplayCancelledError);
    expect(transport.closes).toBe(1);
    expect(run.calls).toEqual([]);
  });

  it("rechecks cancellation after the matched reply before invoking the factory", async () => {
    const controller = new AbortController();
    const transport = new ControlledTransport([matched()], {
      beforePull: (index) => {
        if (index === 0) queueMicrotask(() => controller.abort("between reply and factory"));
      },
    });
    const run = asyncSelection();
    await expect(runClientWithTracesNegotiatedWithReport(
      transport,
      CONFIG,
      ["trace"],
      run.selection,
      { signal: controller.signal },
    )).rejects.toBeInstanceOf(ReplayCancelledError);
    expect(run.calls).toEqual([]);
    expect(transport.closes).toBe(1);
  });

  it("closes the transport when iterator acquisition throws", async () => {
    const transport = new ControlledTransport([], { iteratorError: new Error("iterator failed") });
    const run = asyncSelection();
    await expect(runClientWithTracesNegotiatedWithReport(
      transport, CONFIG, ["trace"], run.selection,
    )).rejects.toThrow("iterator failed");
    expect(transport.closes).toBe(1);
    expect(transport.sent).toEqual([]);
  });

  it("times out a model receive and closes the transport", async () => {
    const transport = new ControlledTransport([
      matched(),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
    ]);
    const run = asyncSelection();
    await expect(runClientWithTracesNegotiatedWithReport(
      transport,
      CONFIG,
      ["trace"],
      run.selection,
      { deadlines: { receiveMs: 5 } },
    )).rejects.toMatchObject({ stage: "receive" });
    expect(transport.closes).toBe(1);
  });

  it("never reports a late async step completion after its deadline", async () => {
    let resolveStep!: (state: State) => void;
    const pending = new Promise<State>((resolve) => { resolveStep = resolve; });
    const transport = new ControlledTransport([
      matched(),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
    ]);
    const run = asyncSelection({ computer: () => pending });
    const promise = runClientWithTracesNegotiatedWithReport(
      transport,
      CONFIG,
      ["trace"],
      run.selection,
      { deadlines: { stepMs: 20 } },
    );
    await expect(promise).rejects.toBeInstanceOf(ReplayDeadlineError);
    resolveStep({ late: { tag: "bool", val: true } });
    await Promise.resolve();
    expect(transport.sent.some((line) => line.includes("report_state"))).toBe(false);
  });

  it("rejects a synchronously blocking async computer after the monotonic deadline", async () => {
    const transport = new ControlledTransport([
      matched(),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
    ]);
    const run = asyncSelection({ computer: async () => {
      const until = performance.now() + 15;
      while (performance.now() < until) { /* deterministic event-loop stall */ }
      return {};
    } });
    await expect(runClientWithTracesNegotiatedWithReport(
      transport,
      CONFIG,
      ["trace"],
      run.selection,
      { deadlines: { stepMs: 5 } },
    )).rejects.toBeInstanceOf(ReplayDeadlineError);
    expect(transport.sent.some((line) => line.includes("report_state"))).toBe(false);
  });

  it("aborts a timed-out factory scope and disposes its late binding", async () => {
    let finishFactory!: (binding: {
      semanticDigest: typeof DIGEST;
      computer: () => Promise<State>;
      assertCompatibleConfig: () => void;
      dispose: () => void;
    }) => void;
    let authoritySignal: AbortSignal | undefined;
    let disposals = 0;
    const factoryResult = new Promise<Parameters<typeof finishFactory>[0]>((resolve) => {
      finishFactory = resolve;
    });
    const registry = new AsyncCompiledAdapterRegistry([{
      key: {
        semanticDigest: DIGEST,
        adapterId: "counter",
        targetProfile: MIRRORECMA_ASYNC_TARGET_PROFILE,
        stateComputerContractVersion: ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
      },
      factory: (_config, authority) => {
        authoritySignal = authority.context.signal;
        return factoryResult;
      },
    }]);
    const transport = new ControlledTransport([matched()]);
    const selection: AsyncCompiledExecutionSelection = {
      execution: "async",
      metadata: METADATA,
      adapterId: "counter",
      targetProfile: MIRRORECMA_ASYNC_TARGET_PROFILE,
      stateComputerContractVersion: ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
      registry,
    };
    await expect(runClientWithTracesNegotiatedWithReport(
      transport,
      CONFIG,
      ["trace"],
      selection,
      { deadlines: { stepMs: 5 } },
    )).rejects.toBeInstanceOf(ReplayDeadlineError);
    expect(authoritySignal?.aborted).toBe(true);
    finishFactory({
      semanticDigest: DIGEST,
      computer: async () => ({}),
      assertCompatibleConfig: () => {},
      dispose: () => { disposals += 1; },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposals).toBe(1);
  });

  it("bounds an async factory in the synchronous report variant", async () => {
    let finish!: (binding: {
      semanticDigest: typeof DIGEST;
      computer: () => State;
      assertCompatibleConfig: () => void;
      dispose: () => void;
    }) => void;
    let disposals = 0;
    const pending = new Promise<Parameters<typeof finish>[0]>((resolve) => { finish = resolve; });
    const selection: SyncCompiledExecutionSelection = {
      execution: "sync",
      metadata: METADATA,
      adapterId: "counter",
      targetProfile: MIRRORECMA_TARGET_PROFILE,
      stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
      registry: new CompiledAdapterRegistry([{
        key: {
          semanticDigest: DIGEST,
          adapterId: "counter",
          targetProfile: MIRRORECMA_TARGET_PROFILE,
          stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
        },
        factory: () => pending,
      }]),
    };
    const transport = new ControlledTransport([matched()]);
    await expect(runClientWithTracesNegotiatedWithReport(
      transport,
      CONFIG,
      ["trace"],
      selection,
      { deadlines: { stepMs: 5 } },
    )).rejects.toBeInstanceOf(ReplayDeadlineError);
    finish({
      semanticDigest: DIGEST,
      computer: () => ({}),
      assertCompatibleConfig: () => {},
      dispose: () => { disposals += 1; },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposals).toBe(1);
  });

  it("preserves a non-Error computer rejection over cleanup failure", async () => {
    const transport = new ControlledTransport([
      matched(),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
    ]);
    const run = asyncSelection({
      computer: () => Promise.reject(undefined),
      dispose: () => { throw new Error("dispose failed"); },
    });
    const error = await runClientWithTracesNegotiatedWithReport(
      transport, CONFIG, ["trace"], run.selection,
    ).catch((cause) => cause);
    expect(error).toBeInstanceOf(ReplayThrownValueError);
    expect(replayCleanupFailure(error)).toMatchObject({ code: "adapter_dispose_failed" });
  });

  it("throws a structured mismatch with private coordinates", async () => {
    const transport = new ControlledTransport([
      matched(),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
      JSON.stringify({
        proto_step: "step_mismatch",
        action: "init",
        expected: { count: { "#bigint": "1" } },
        actual: { count: { "#bigint": "0" } },
        hints: [],
      }),
    ]);
    const run = asyncSelection();
    const error = await runClientWithTracesNegotiatedWithReport(
      transport, CONFIG, ["trace"], run.selection,
    ).catch((cause) => cause);
    expect(error).toBeInstanceOf(ReplayMismatchError);
    expect(error).toMatchObject({ traceIndex: 0, stepIndex: 0, action: "init" });
  });

  it("keeps synchronous compute-to-encode immediate across a mutating microtask", async () => {
    const transport = new ControlledTransport([
      matched(),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
      JSON.stringify({ proto_step: "all_steps_done" }),
    ]);
    const selection = syncSelection(() => {
      const state: State = { count: { tag: "int", val: 1n } };
      queueMicrotask(() => { state.count = { tag: "int", val: 2n }; });
      return state;
    });
    await runClientNegotiatedWithReport(transport, CONFIG, { numTraces: 1 }, selection);
    const report = transport.sent.find((line) => line.includes("report_state"))!;
    expect(JSON.parse(report).state.count).toEqual({ "#bigint": "1" });
  });

  it("rejects invalid timer budgets before opening the transport", async () => {
    const transport = new ControlledTransport([matched()]);
    const run = asyncSelection();
    await expect(runClientWithTracesNegotiatedWithReport(
      transport,
      CONFIG,
      ["trace"],
      run.selection,
      { deadlines: { stepMs: 0x80000000 } },
    )).rejects.toBeInstanceOf(RangeError);
    expect(transport.sent).toEqual([]);
    expect(transport.closes).toBe(0);
  });
});
