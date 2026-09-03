import { readFileSync } from "node:fs";
import {
  CompiledAdapterRegistry,
  MIRRORECMA_TARGET_PROFILE,
  ModelInterfaceRegistrationError,
  NegotiatedRunnerError,
  STATE_COMPUTER_CONTRACT_VERSION,
  runClientNegotiated,
  runClientWithTracesNegotiated,
  type AdapterFactory,
  type CompiledAdapterSelection,
  type DynamicHandlerSelection,
  type LocalBinding,
} from "../src/client.js";
import {
  canonicalSemanticDescriptorBytes,
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
  semanticDigestFromHex,
  type ContractV1,
  type GeneratedModelInterface,
  type NegotiationPolicy,
  type SemanticDescriptor,
} from "../src/model-interface.js";
import { DescriptorCache } from "../src/descriptor-cache.js";
import { DynamicBindingError, type NativeModelValue } from "../src/dynamic-binding.js";
import { PassThrough } from "node:stream";
import type {
  ApalacheConfig,
  StateComputer,
} from "../src/protocol.js";
import { protocolLineIterator, type Transport } from "../src/transport.js";

const DIGEST_HEX = "a".repeat(64);
const DIGEST = semanticDigestFromHex(DIGEST_HEX);
const CFG: ApalacheConfig = {
  specPath: "Counter.tla",
  invariant: "TraceComplete",
  lengthBound: 2,
};
const DYNAMIC_CFG: ApalacheConfig = { ...CFG, paramVars: "parameters" };

const METADATA: GeneratedModelInterface = {
  semanticDigest: DIGEST_HEX,
  contract: {
    schema: "mirrors.model-interface/v1",
    interfaceVersion: "1.0.0",
    model: { module: "Counter", source: "Counter.tla" },
    wire: { actionVariable: "action_taken", parameterVariable: null },
    initializers: [{ id: "Initialize", wireAction: "init", wireAliases: [], inputs: [] }],
    actions: [],
    observations: [{ id: "Count", wireName: "count", provenance: "implementation" }],
  },
};

function counterArtifacts(): { descriptor: SemanticDescriptor; contract: ContractV1 } {
  const lock = JSON.parse(readFileSync(
    new URL("./fixtures/model-interface/counter/Counter.mirror-interface.lock.json", import.meta.url),
    "utf8",
  )) as Record<string, any>;
  const { contract, semanticDigest: _semantic, provenanceDigest: _provenanceDigest, provenance: _provenance, ...rest } = lock;
  return {
    descriptor: decodeSemanticDescriptor({
      ...rest,
      schema: "mirrors.model-interface-descriptor/v1",
    }),
    contract,
  };
}

function resolvedReply(descriptor: SemanticDescriptor): string {
  return JSON.stringify({
    proto_step: "spec_validated",
    result: "valid",
    modelInterface: {
      schema: "mirrors.model-interface-negotiation/v1",
      status: "resolved",
      descriptorSchema: "mirrors.model-interface-descriptor/v1",
      semanticDigest: `sha256:${semanticDescriptorDigest(descriptor)}`,
      descriptorBytes: canonicalSemanticDescriptorBytes(descriptor).byteLength,
      descriptor,
    },
  });
}

function specValidated(status: "matched" | "unsupported" | "unavailable" = "matched"): string {
  const modelInterface = status === "matched"
    ? {
        schema: "mirrors.model-interface-negotiation/v1",
        status,
        descriptorSchema: "mirrors.model-interface-descriptor/v1",
        semanticDigest: `sha256:${DIGEST_HEX}`,
      }
    : { schema: "mirrors.model-interface-negotiation/v1", status };
  return JSON.stringify({ proto_step: "spec_validated", result: "valid", modelInterface });
}

class ScriptedTransport implements Transport {
  readonly sent: string[] = [];
  closes = 0;
  private offset = 0;

  constructor(
    private readonly replies: readonly string[],
    private readonly beforePull?: (index: number) => void,
  ) {}

  send(line: string): void {
    this.sent.push(line);
  }

  async close(): Promise<number> {
    this.closes += 1;
    return 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        const index = this.offset++;
        this.beforePull?.(index);
        if (index >= this.replies.length) return { value: "", done: true };
        return { value: this.replies[index]!, done: false };
      },
    };
  }
}

class FramedTransport implements Transport {
  readonly sent: string[] = [];
  closes = 0;
  private readonly input = new PassThrough();
  private readonly iterator: AsyncIterator<string>;
  private closeResult: Promise<number> | undefined;

  constructor(bytes: Buffer) {
    this.iterator = protocolLineIterator(this.input, () => this.close());
    this.input.end(bytes);
  }

  send(line: string): void {
    this.sent.push(line);
  }

  close(): Promise<number> {
    return this.closeResult ??= Promise.resolve().then(() => {
      this.closes += 1;
      this.input.destroy();
      return 0;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return this.iterator;
  }
}

interface Counters {
  factory: number;
  computer: number;
  dispose: number;
  config: number;
}

function selection(
  counters: Counters,
  options: {
    policy?: NegotiationPolicy;
    fallbackFactory?: AdapterFactory;
    computer?: StateComputer;
    configError?: Error;
    disposeError?: Error;
    bindingDigest?: typeof DIGEST;
  } = {},
): CompiledAdapterSelection {
  const registry = new CompiledAdapterRegistry([{
    key: {
      semanticDigest: DIGEST,
      adapterId: "counter",
      targetProfile: MIRRORECMA_TARGET_PROFILE,
      stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
    },
    factory: () => {
      counters.factory += 1;
      const binding: LocalBinding = {
        semanticDigest: options.bindingDigest ?? DIGEST,
        computer: options.computer ?? (() => {
          counters.computer += 1;
          return { count: { tag: "int", val: 0n } };
        }),
        assertCompatibleConfig: () => {
          counters.config += 1;
          if (options.configError) throw options.configError;
        },
        dispose: () => {
          counters.dispose += 1;
          if (options.disposeError) throw options.disposeError;
        },
      };
      return binding;
    },
  }]);
  return {
    metadata: METADATA,
    adapterId: "counter",
    targetProfile: MIRRORECMA_TARGET_PROFILE,
    stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
    registry,
    policy: options.policy,
    fallbackFactory: options.fallbackFactory,
  };
}

function counters(): Counters {
  return { factory: 0, computer: 0, dispose: 0, config: 0 };
}

function makeFallbackFactory(
  calls: Counters,
  options: {
    computer?: StateComputer;
    factoryError?: Error;
    configError?: Error;
    disposeError?: Error;
  } = {},
): AdapterFactory {
  return () => {
    calls.factory += 1;
    if (options.factoryError) throw options.factoryError;
    return {
      semanticDigest: DIGEST,
      computer: options.computer ?? (() => {
        calls.computer += 1;
        return {};
      }),
      assertCompatibleConfig: () => {
        calls.config += 1;
        if (options.configError) throw options.configError;
      },
      dispose: () => {
        calls.dispose += 1;
        if (options.disposeError) throw options.disposeError;
      },
    };
  };
}

interface DynamicCalls {
  action: number;
  observation: number;
  dispose: number;
}

function dynamicCalls(): DynamicCalls {
  return { action: 0, observation: 0, dispose: 0 };
}

function dynamicSelection(
  cache: DescriptorCache,
  calls: DynamicCalls,
  options: {
    descriptor?: SemanticDescriptor;
    policy?: NegotiationPolicy;
    fallbackFactory?: AdapterFactory;
    actions?: Record<string, (inputs: Readonly<Record<string, NativeModelValue>>) => void>;
    observations?: Record<string, () => NativeModelValue>;
    observerOffset?: bigint;
    disposeError?: Error;
  } = {},
): DynamicHandlerSelection {
  const artifacts = counterArtifacts();
  const descriptor = options.descriptor ?? artifacts.descriptor;
  let count = 0n;
  return {
    mode: "dynamic",
    contract: artifacts.contract,
    descriptorCache: cache,
    policy: options.policy,
    fallbackFactory: options.fallbackFactory,
    registry: {
      semanticDigest: semanticDescriptorDigest(descriptor),
      actions: options.actions ?? {
        Initialize: () => { calls.action += 1; count = 0n; },
        Tick: (inputs) => { calls.action += 1; count += inputs.Stride as bigint; },
      },
      observations: options.observations ?? {
        Count: () => { calls.observation += 1; return count + (options.observerOffset ?? 0n); },
      },
    },
    dispose: () => {
      calls.dispose += 1;
      if (options.disposeError) throw options.disposeError;
    },
  };
}

describe("negotiated model-interface runner", () => {
  it("fails closed when an otherwise-valid matched reply reaches EOF without LF", async () => {
    const calls = counters();
    const transport = new FramedTransport(Buffer.from(specValidated()));

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls),
    )).rejects.toMatchObject({ code: "negotiation_status_unexpected" });

    expect(calls).toEqual({ factory: 0, computer: 0, dispose: 0, config: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent.some((line) => line.includes("report_state"))).toBe(false);
    expect(transport.closes).toBe(1);
  });

  it("retrieves, caches, and reuses a dynamic descriptor through not_modified", async () => {
    const { descriptor } = counterArtifacts();
    const cache = new DescriptorCache();
    const firstCalls = dynamicCalls();
    const first = new ScriptedTransport([
      resolvedReply(descriptor),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
      JSON.stringify({ proto_step: "all_steps_done" }),
    ]);

    await runClientNegotiated(
      first,
      DYNAMIC_CFG,
      { numTraces: 1 },
      dynamicSelection(cache, firstCalls),
    );
    expect(firstCalls).toEqual({ action: 1, observation: 1, dispose: 1 });
    expect(JSON.parse(first.sent[0]!)).toMatchObject({
      modelInterface: {
        request: "descriptor",
        policy: "require",
        expectedSemanticDigest: `sha256:${semanticDescriptorDigest(descriptor)}`,
      },
    });
    expect(JSON.parse(first.sent[0]!).modelInterface).not.toHaveProperty("ifNoneMatch");
    expect(cache.require(semanticDescriptorDigest(descriptor)).descriptorBytes).toBeGreaterThan(0);

    const secondCalls = dynamicCalls();
    const second = new ScriptedTransport([
      JSON.stringify({
        proto_step: "spec_validated",
        result: "valid",
        modelInterface: {
          schema: "mirrors.model-interface-negotiation/v1",
          status: "not_modified",
          descriptorSchema: "mirrors.model-interface-descriptor/v1",
          semanticDigest: `sha256:${semanticDescriptorDigest(descriptor)}`,
        },
      }),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
      JSON.stringify({ proto_step: "all_steps_done" }),
    ]);
    await runClientNegotiated(
      second,
      DYNAMIC_CFG,
      { numTraces: 1 },
      dynamicSelection(cache, secondCalls),
    );
    expect(JSON.parse(second.sent[0]!)).toMatchObject({
      modelInterface: { ifNoneMatch: `sha256:${semanticDescriptorDigest(descriptor)}` },
    });
    expect(secondCalls).toEqual({ action: 1, observation: 1, dispose: 1 });
    expect(second.closes).toBe(1);
  });

  it("rejects not_modified without a valid exact-digest cache entry", async () => {
    const { descriptor } = counterArtifacts();
    const cache = new DescriptorCache({ maxEntries: 1 });
    cache.put(descriptor);
    const calls = dynamicCalls();
    let transport!: ScriptedTransport;
    transport = new ScriptedTransport([JSON.stringify({
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "not_modified",
        descriptorSchema: "mirrors.model-interface-descriptor/v1",
        semanticDigest: `sha256:${semanticDescriptorDigest(descriptor)}`,
      },
    })], (index) => {
      if (index === 0) {
        expect(JSON.parse(transport.sent[0]!).modelInterface).toHaveProperty("ifNoneMatch");
        const replacement: any = structuredClone(descriptor);
        replacement.interfaceVersion = "1.0.1";
        cache.put(decodeSemanticDescriptor(replacement));
      }
    });

    await expect(runClientNegotiated(
      transport,
      DYNAMIC_CFG,
      { numTraces: 1 },
      dynamicSelection(cache, calls),
    )).rejects.toMatchObject({ code: "not_modified_without_cache" });
    expect(calls).toEqual({ action: 0, observation: 0, dispose: 0 });
    expect(transport.sent.some((line) => line.includes("report_state"))).toBe(false);
    expect(transport.closes).toBe(1);
  });

  it("never sends a corrupt cache entry as ifNoneMatch and rejects an unsolicited not_modified", async () => {
    const { descriptor } = counterArtifacts();
    const digest = semanticDescriptorDigest(descriptor);
    const cache = new DescriptorCache();
    cache.put(descriptor);
    const internal = cache as unknown as {
      entries: Map<string, { canonicalBytes: Uint8Array }>;
    };
    internal.entries.get(digest)!.canonicalBytes[0] ^= 0xff;
    const calls = dynamicCalls();
    const transport = new ScriptedTransport([JSON.stringify({
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "not_modified",
        descriptorSchema: "mirrors.model-interface-descriptor/v1",
        semanticDigest: `sha256:${digest}`,
      },
    })]);

    await expect(runClientNegotiated(
      transport,
      DYNAMIC_CFG,
      { numTraces: 1 },
      dynamicSelection(cache, calls),
    )).rejects.toMatchObject({ code: "negotiation_status_unexpected" });
    expect(JSON.parse(transport.sent[0]!).modelInterface).not.toHaveProperty("ifNoneMatch");
    expect(calls).toEqual({ action: 0, observation: 0, dispose: 0 });
  });

  it("rejects not_modified when the cache was populated only after registration", async () => {
    const { descriptor } = counterArtifacts();
    const digest = semanticDescriptorDigest(descriptor);
    const cache = new DescriptorCache();
    const calls = dynamicCalls();
    let transport!: ScriptedTransport;
    transport = new ScriptedTransport([JSON.stringify({
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "not_modified",
        descriptorSchema: "mirrors.model-interface-descriptor/v1",
        semanticDigest: `sha256:${digest}`,
      },
    })], (index) => {
      if (index === 0) {
        expect(JSON.parse(transport.sent[0]!).modelInterface).not.toHaveProperty("ifNoneMatch");
        cache.put(descriptor);
      }
    });

    await expect(runClientNegotiated(
      transport,
      DYNAMIC_CFG,
      { numTraces: 1 },
      dynamicSelection(cache, calls),
    )).rejects.toMatchObject({ code: "negotiation_status_unexpected" });
    expect(calls).toEqual({ action: 0, observation: 0, dispose: 0 });
    expect(transport.sent.filter((line) => line.includes("report_state"))).toHaveLength(0);
    expect(transport.closes).toBe(1);
  });

  it("rejects wrong descriptor digests and missing descriptors before callbacks", async () => {
    const { descriptor } = counterArtifacts();
    for (const [reply, code] of [
      [JSON.stringify({
        proto_step: "spec_validated",
        result: "valid",
        modelInterface: {
          schema: "mirrors.model-interface-negotiation/v1",
          status: "not_modified",
          descriptorSchema: "mirrors.model-interface-descriptor/v1",
          semanticDigest: `sha256:${"b".repeat(64)}`,
        },
      }), "interface_digest_mismatch"],
      [JSON.stringify({
        proto_step: "spec_validated",
        result: "valid",
        modelInterface: {
          schema: "mirrors.model-interface-negotiation/v1",
          status: "resolved",
          descriptorSchema: "mirrors.model-interface-descriptor/v1",
          semanticDigest: `sha256:${semanticDescriptorDigest(descriptor)}`,
          descriptorBytes: 1,
        },
      }), "descriptor_missing"],
    ] as const) {
      const calls = dynamicCalls();
      const transport = new ScriptedTransport([reply]);
      await expect(runClientNegotiated(
        transport,
        DYNAMIC_CFG,
        { numTraces: 1 },
        dynamicSelection(new DescriptorCache(), calls),
      )).rejects.toMatchObject({ code });
      expect(calls).toEqual({ action: 0, observation: 0, dispose: 0 });
      expect(transport.sent.some((line) => line.includes("report_state"))).toBe(false);
    }
  });

  it.each([
    ["handler_missing", { actions: { Initialize: () => {} } }],
    ["handler_extra", { actions: { Initialize: () => {}, Tick: () => {}, Extra: () => {} } }],
    ["observer_missing", { observations: {} }],
    ["observer_extra", { observations: { Count: () => 0n, Extra: () => 0n } }],
  ] as const)("rejects dynamic %s before any callback", async (code, overrides) => {
    const { descriptor } = counterArtifacts();
    const calls = dynamicCalls();
    const transport = new ScriptedTransport([resolvedReply(descriptor)]);
    const selectionValue = dynamicSelection(new DescriptorCache(), calls, overrides);

    await expect(runClientNegotiated(
      transport,
      DYNAMIC_CFG,
      { numTraces: 1 },
      selectionValue,
    )).rejects.toMatchObject({ code });
    expect(calls).toEqual({ action: 0, observation: 0, dispose: 0 });
    expect(transport.sent.some((line) => line.includes("report_state"))).toBe(false);
  });

  it("rejects opaqueItf before callbacks and before report_state", async () => {
    const artifacts = counterArtifacts();
    const raw: any = structuredClone(artifacts.descriptor);
    raw.observations[0].type = { kind: "opaqueItf", description: "unsupported" };
    const descriptor = decodeSemanticDescriptor(raw);
    const calls = dynamicCalls();
    const transport = new ScriptedTransport([resolvedReply(descriptor)]);

    await expect(runClientNegotiated(
      transport,
      DYNAMIC_CFG,
      { numTraces: 1 },
      dynamicSelection(new DescriptorCache(), calls, { descriptor }),
    )).rejects.toMatchObject({ code: "descriptor_type_unsupported" });
    expect(calls).toEqual({ action: 0, observation: 0, dispose: 0 });
    expect(transport.sent.some((line) => line.includes("report_state"))).toBe(false);
  });

  it("rejects compiled/dynamic request-mode mismatches before registration", async () => {
    const compiledCalls = counters();
    const compiledTransport = new ScriptedTransport([]);
    await expect(runClientNegotiated(
      compiledTransport,
      CFG,
      { numTraces: 1 },
      { ...selection(compiledCalls), request: "descriptor" } as unknown as CompiledAdapterSelection,
    )).rejects.toMatchObject({ code: "negotiation_status_unexpected" });
    expect(compiledTransport.sent).toEqual([]);

    const dynamicProbe = dynamicCalls();
    const dynamicTransport = new ScriptedTransport([]);
    await expect(runClientNegotiated(
      dynamicTransport,
      DYNAMIC_CFG,
      { numTraces: 1 },
      {
        ...dynamicSelection(new DescriptorCache(), dynamicProbe),
        request: "verify",
      } as unknown as DynamicHandlerSelection,
    )).rejects.toMatchObject({ code: "negotiation_status_unexpected" });
    expect(dynamicTransport.sent).toEqual([]);
    expect(dynamicProbe).toEqual({ action: 0, observation: 0, dispose: 0 });
  });

  it.each(["unsupported", "too_large"] as const)(
    "uses only an explicit dynamic prefer fallback for %s",
    async (status) => {
      const { descriptor } = counterArtifacts();
      const calls = dynamicCalls();
      const fallbackCalls = counters();
      const fallbackFactory: AdapterFactory = () => {
        fallbackCalls.factory += 1;
        return {
          semanticDigest: semanticDescriptorDigest(descriptor),
          computer: () => { fallbackCalls.computer += 1; return {}; },
          assertCompatibleConfig: () => { fallbackCalls.config += 1; },
          dispose: () => { fallbackCalls.dispose += 1; },
        };
      };
      const reply = status === "unsupported"
        ? { schema: "mirrors.model-interface-negotiation/v1", status }
        : {
            schema: "mirrors.model-interface-negotiation/v1",
            status,
            descriptorSchema: "mirrors.model-interface-descriptor/v1",
            semanticDigest: `sha256:${semanticDescriptorDigest(descriptor)}`,
            descriptorBytes: 40_000,
          };
      const transport = new ScriptedTransport([
        JSON.stringify({ proto_step: "spec_validated", result: "valid", modelInterface: reply }),
        JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
        JSON.stringify({ proto_step: "all_steps_done" }),
      ]);
      await runClientNegotiated(
        transport,
        DYNAMIC_CFG,
        { numTraces: 1 },
        dynamicSelection(new DescriptorCache(), calls, {
          policy: "prefer",
          fallbackFactory,
        }),
      );
      expect(calls).toEqual({ action: 0, observation: 0, dispose: 0 });
      expect(fallbackCalls).toEqual({ factory: 1, computer: 1, dispose: 1, config: 1 });
      expect(transport.sent.filter((line) => line.includes("report_state"))).toHaveLength(1);
    },
  );

  it("preserves dynamic replay failure over cleanup failure and disposes once", async () => {
    const { descriptor } = counterArtifacts();
    const calls = dynamicCalls();
    const primary = new Error("handler failed");
    const transport = new ScriptedTransport([
      resolvedReply(descriptor),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
    ]);
    await expect(runClientNegotiated(
      transport,
      DYNAMIC_CFG,
      { numTraces: 1 },
      dynamicSelection(new DescriptorCache(), calls, {
        actions: { Initialize: () => { throw primary; }, Tick: () => {} },
        disposeError: new Error("cleanup failed"),
      }),
    )).rejects.toMatchObject({ code: "adapter_failure" });
    expect(calls.dispose).toBe(1);
    expect(transport.closes).toBe(1);
  });

  it("keeps an incorrect dynamic observer on the ordinary step_mismatch path", async () => {
    const { descriptor } = counterArtifacts();
    const calls = dynamicCalls();
    const transport = new ScriptedTransport([
      resolvedReply(descriptor),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
      JSON.stringify({
        proto_step: "step_mismatch",
        action: "init",
        expected: { count: 0 },
        actual: { count: 1 },
      }),
    ]);
    const promise = runClientNegotiated(
      transport,
      DYNAMIC_CFG,
      { numTraces: 1 },
      dynamicSelection(new DescriptorCache(), calls, { observerOffset: 1n }),
    );
    await expect(promise).rejects.toThrow("step mismatch");
    await expect(promise).rejects.not.toBeInstanceOf(DynamicBindingError);
    expect(calls).toEqual({ action: 1, observation: 1, dispose: 1 });
    expect(transport.closes).toBe(1);
  });

  it("creates the exact adapter only after matched and reuses ordinary replay", async () => {
    const calls = counters();
    let transport!: ScriptedTransport;
    transport = new ScriptedTransport([
      specValidated(),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
      JSON.stringify({ proto_step: "all_steps_done" }),
    ], (index) => {
      if (index === 0) {
        expect(calls.factory).toBe(0);
        expect(calls.computer).toBe(0);
        expect(transport.sent.some((line) => line.includes("report_state"))).toBe(false);
      }
    });

    await runClientNegotiated(transport, CFG, { numTraces: 1 }, selection(calls));

    expect(calls).toEqual({ factory: 1, computer: 1, dispose: 1, config: 1 });
    expect(transport.closes).toBe(1);
    expect(JSON.parse(transport.sent[0]!)).toMatchObject({
      proto_step: "register",
      modelInterface: {
        request: "verify",
        policy: "require",
        expectedSemanticDigest: `sha256:${DIGEST_HEX}`,
      },
    });
    expect(JSON.parse(transport.sent[1]!)).toEqual({
      proto_step: "report_state",
      state: { count: { "#bigint": "0" } },
    });
  });

  it("fails closed on an old server with zero factory, SUT, and report_state calls", async () => {
    const calls = counters();
    const transport = new ScriptedTransport([
      JSON.stringify({ proto_step: "spec_validated", result: "valid" }),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
    ]);

    await expect(runClientWithTracesNegotiated(
      transport,
      CFG,
      ["counter.itf.json"],
      selection(calls),
    )).rejects.toMatchObject({ code: "negotiation_missing" });

    expect(calls).toEqual({ factory: 0, computer: 0, dispose: 0, config: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).not.toContain("report_state");
    expect(transport.closes).toBe(1);
  });

  it("uses an explicit fresh prefer fallback when an old server omits negotiation", async () => {
    const calls = counters();
    const fallbackCalls = counters();
    const transport = new ScriptedTransport([
      JSON.stringify({ proto_step: "spec_validated", result: "valid" }),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
      JSON.stringify({ proto_step: "all_steps_done" }),
    ]);

    await runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls, {
        policy: "prefer",
        fallbackFactory: makeFallbackFactory(fallbackCalls),
      }),
    );

    expect(fallbackCalls).toEqual({ factory: 1, computer: 1, dispose: 1, config: 1 });
    expect(calls.factory).toBe(0);
    expect(transport.sent.filter((line) => line.includes("report_state"))).toHaveLength(1);
    expect(transport.closes).toBe(1);
  });

  it("rejects an old server under prefer when no fallback factory was supplied", async () => {
    const calls = counters();
    const transport = new ScriptedTransport([
      JSON.stringify({ proto_step: "spec_validated", result: "valid" }),
    ]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls, { policy: "prefer" }),
    )).rejects.toMatchObject({ code: "legacy_fallback_unavailable" });

    expect(calls.factory).toBe(0);
    expect(transport.closes).toBe(1);
  });

  it.each(["unsupported", "unavailable"] as const)(
    "uses only an explicit prefer fallback for %s",
    async (status) => {
      const calls = counters();
      const fallbackCalls = counters();
      const transport = new ScriptedTransport([
        specValidated(status),
        JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
        JSON.stringify({ proto_step: "all_steps_done" }),
      ]);

      await runClientNegotiated(
        transport,
        CFG,
        { numTraces: 1 },
        selection(calls, {
          policy: "prefer",
          fallbackFactory: makeFallbackFactory(fallbackCalls),
        }),
      );

      expect(fallbackCalls).toEqual({ factory: 1, computer: 1, dispose: 1, config: 1 });
      expect(calls.factory).toBe(0);
      expect(transport.sent.filter((line) => line.includes("report_state"))).toHaveLength(1);
      expect(transport.closes).toBe(1);
    },
  );

  it("does not treat a mismatch registration error as a prefer fallback", async () => {
    const calls = counters();
    const fallbackCalls = counters();
    const transport = new ScriptedTransport([JSON.stringify({
      proto_step: "register_error",
      error: "model interface digest mismatch",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "mismatch",
        code: "interface_digest_mismatch",
        expectedSemanticDigest: `sha256:${DIGEST_HEX}`,
      },
    })]);

    const promise = runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls, {
        policy: "prefer",
        fallbackFactory: makeFallbackFactory(fallbackCalls),
      }),
    );
    await expect(promise).rejects.toBeInstanceOf(ModelInterfaceRegistrationError);
    await expect(promise).rejects.toMatchObject({ code: "interface_digest_mismatch" });
    expect(fallbackCalls.factory).toBe(0);
    expect(calls.factory).toBe(0);
    expect(transport.closes).toBe(1);
  });

  it("rejects a structured register_error correlated to a different request digest", async () => {
    const calls = counters();
    const fallbackCalls = counters();
    const transport = new ScriptedTransport([JSON.stringify({
      proto_step: "register_error",
      error: "model interface digest mismatch",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "mismatch",
        code: "interface_digest_mismatch",
        expectedSemanticDigest: `sha256:${"b".repeat(64)}`,
      },
    })]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls, {
        policy: "prefer",
        fallbackFactory: makeFallbackFactory(fallbackCalls),
      }),
    )).rejects.toMatchObject({ code: "negotiation_status_unexpected" });

    expect(calls.factory).toBe(0);
    expect(fallbackCalls.factory).toBe(0);
    expect(transport.sent).toHaveLength(1);
    expect(transport.closes).toBe(1);
  });

  it("classifies fallback factory failure and still closes once", async () => {
    const calls = counters();
    const fallbackCalls = counters();
    const transport = new ScriptedTransport([
      JSON.stringify({ proto_step: "spec_validated", result: "valid" }),
    ]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls, {
        policy: "prefer",
        fallbackFactory: makeFallbackFactory(fallbackCalls, {
          factoryError: new Error("fallback allocation failed"),
        }),
      }),
    )).rejects.toMatchObject({ code: "adapter_factory_failed" });

    expect(fallbackCalls).toEqual({ factory: 1, computer: 0, dispose: 0, config: 0 });
    expect(transport.closes).toBe(1);
  });

  it("disposes a fallback binding exactly once when its config recheck fails", async () => {
    const calls = counters();
    const fallbackCalls = counters();
    const transport = new ScriptedTransport([specValidated("unavailable")]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls, {
        policy: "prefer",
        fallbackFactory: makeFallbackFactory(fallbackCalls, {
          configError: new Error("fallback config mismatch"),
        }),
      }),
    )).rejects.toMatchObject({ code: "binding_config_mismatch" });

    expect(fallbackCalls).toEqual({ factory: 1, computer: 0, dispose: 1, config: 1 });
    expect(transport.closes).toBe(1);
  });

  it("disposes a fallback once on replay failure and preserves that primary error", async () => {
    const calls = counters();
    const fallbackCalls = counters();
    const primary = new Error("legacy SUT failed");
    const transport = new ScriptedTransport([
      specValidated("unsupported"),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
    ]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls, {
        policy: "prefer",
        fallbackFactory: makeFallbackFactory(fallbackCalls, {
          computer: () => {
            fallbackCalls.computer += 1;
            throw primary;
          },
          disposeError: new Error("fallback cleanup failed"),
        }),
      }),
    )).rejects.toBe(primary);

    expect(fallbackCalls).toEqual({ factory: 1, computer: 1, dispose: 1, config: 1 });
    expect(transport.closes).toBe(1);
  });

  it("disposes once when StateComputer throws and preserves the primary error", async () => {
    const calls = counters();
    const primary = new Error("SUT failed");
    const transport = new ScriptedTransport([
      specValidated(),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
    ]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls, {
        computer: () => {
          calls.computer += 1;
          throw primary;
        },
        disposeError: new Error("cleanup also failed"),
      }),
    )).rejects.toBe(primary);

    expect(calls.dispose).toBe(1);
    expect(transport.closes).toBe(1);
  });

  it("disposes once on a step mismatch", async () => {
    const calls = counters();
    const transport = new ScriptedTransport([
      specValidated(),
      JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
      JSON.stringify({
        proto_step: "step_mismatch",
        action: "init",
        expected: { count: 1 },
        actual: { count: 0 },
      }),
    ]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls),
    )).rejects.toThrow("step mismatch");

    expect(calls.dispose).toBe(1);
    expect(transport.closes).toBe(1);
  });

  it("rejects the server digest before factory creation or report_state", async () => {
    const calls = counters();
    const wrongDigest = "b".repeat(64);
    const transport = new ScriptedTransport([JSON.stringify({
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "matched",
        descriptorSchema: "mirrors.model-interface-descriptor/v1",
        semanticDigest: `sha256:${wrongDigest}`,
      },
    })]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls),
    )).rejects.toMatchObject({ code: "interface_digest_mismatch" });

    expect(calls.factory).toBe(0);
    expect(transport.sent).toHaveLength(1);
    expect(transport.closes).toBe(1);
  });

  it("keeps descriptor-mode statuses invalid for the compiled D3 runner", async () => {
    const calls = counters();
    const transport = new ScriptedTransport([JSON.stringify({
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "not_modified",
        descriptorSchema: "mirrors.model-interface-descriptor/v1",
        semanticDigest: `sha256:${DIGEST_HEX}`,
      },
    })]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls),
    )).rejects.toMatchObject({ code: "negotiation_status_unexpected" });

    expect(calls).toEqual({ factory: 0, computer: 0, dispose: 0, config: 0 });
    expect(transport.sent.some((line) => line.includes("report_state"))).toBe(false);
    expect(transport.closes).toBe(1);
  });

  it("classifies a malformed reply digest and closes without creating an adapter", async () => {
    const calls = counters();
    const transport = new ScriptedTransport([JSON.stringify({
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "matched",
        descriptorSchema: "mirrors.model-interface-descriptor/v1",
        semanticDigest: "sha256:not-a-digest",
      },
    })]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls),
    )).rejects.toMatchObject({ code: "descriptor_digest_invalid" });

    expect(calls.factory).toBe(0);
    expect(transport.sent).toHaveLength(1);
    expect(transport.closes).toBe(1);
  });

  it("disposes a created binding when its configuration recheck fails", async () => {
    const calls = counters();
    const transport = new ScriptedTransport([specValidated()]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls, { configError: new Error("wrong paramVars") }),
    )).rejects.toMatchObject({ code: "binding_config_mismatch" });

    expect(calls).toEqual({ factory: 1, computer: 0, dispose: 1, config: 1 });
    expect(transport.closes).toBe(1);
  });

  it("reports disposal failure only after successful replay and closes once", async () => {
    const calls = counters();
    const transport = new ScriptedTransport([
      specValidated(),
      JSON.stringify({ proto_step: "all_steps_done" }),
    ]);

    await expect(runClientNegotiated(
      transport,
      CFG,
      { numTraces: 1 },
      selection(calls, { disposeError: new Error("cleanup failed") }),
    )).rejects.toMatchObject({ code: "adapter_dispose_failed" });

    expect(calls.dispose).toBe(1);
    expect(transport.closes).toBe(1);
  });

  it("rejects a non-exact registry key before factory creation", async () => {
    const calls = counters();
    const wrongRegistry = new CompiledAdapterRegistry([{
      key: {
        semanticDigest: DIGEST,
        adapterId: "counter",
        targetProfile: "another-profile",
        stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
      },
      factory: () => {
        calls.factory += 1;
        throw new Error("must not run");
      },
    }]);
    const transport = new ScriptedTransport([specValidated()]);

    await expect(runClientNegotiated(transport, CFG, { numTraces: 1 }, {
      ...selection(calls),
      registry: wrongRegistry,
    })).rejects.toMatchObject({ code: "target_profile_mismatch" });

    expect(calls.factory).toBe(0);
    expect(transport.sent).toHaveLength(0);
    expect(transport.closes).toBe(0);
  });

  it("deep-clones and freezes registrations so caller mutation cannot retarget lookup", () => {
    let originalFactoryCalls = 0;
    let replacementFactoryCalls = 0;
    const key = {
      semanticDigest: DIGEST,
      adapterId: "counter",
      targetProfile: MIRRORECMA_TARGET_PROFILE,
      stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
    };
    const registration = {
      key,
      factory: (() => {
        originalFactoryCalls += 1;
        throw new Error("only identity is tested");
      }) as AdapterFactory,
    };
    const entries = [registration];
    const registry = new CompiledAdapterRegistry(entries);

    key.adapterId = "mutated";
    registration.factory = () => {
      replacementFactoryCalls += 1;
      throw new Error("replacement must not be retained");
    };
    entries.length = 0;

    const retained = registry.resolve({
      semanticDigest: DIGEST,
      adapterId: "counter",
      targetProfile: MIRRORECMA_TARGET_PROFILE,
      stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
    });
    expect(() => retained(CFG)).toThrow("only identity is tested");
    expect(originalFactoryCalls).toBe(1);
    expect(replacementFactoryCalls).toBe(0);

    const internal = (registry as unknown as {
      registrations: readonly { key: object }[];
    }).registrations;
    expect(Object.isFrozen(internal)).toBe(true);
    expect(Object.isFrozen(internal[0])).toBe(true);
    expect(Object.isFrozen(internal[0]!.key)).toBe(true);
  });

  it("uses stable typed local negotiation errors", () => {
    const error = new NegotiatedRunnerError("adapter_not_registered", "missing");
    expect(error).toMatchObject({
      name: "NegotiatedRunnerError",
      code: "adapter_not_registered",
      message: "missing",
    });
  });
});
