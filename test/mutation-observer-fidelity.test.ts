import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  defineSuite,
  runMutationCampaign,
  runSuite,
  decodeSemanticDescriptor,
  type NativeSuiteAdapter,
  type SuiteModel,
  type ReplayPlan,
  type Transport,
} from "../src/index.js";
import {
  CounterModelInterface,
  CounterPublicManifest,
  bindCounterAsyncPublicPort,
} from "./fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";
import {
  withObserverControl,
  runIndependentProbe,
  probeDefinitions,
} from "../examples/application-validation/fidelity.mjs";
import { WorkQueue, BrokenWorkQueue } from "../examples/work-queue/queue.js";
import { defineApplicationSuite as defineLeaseSuite } from "../examples/lease-service/suite.js";
import { evaluateLocal } from "../examples/application-validation/suite.mjs";

const lock = JSON.parse(
  readFileSync(
    resolve(
      "test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json",
    ),
    "utf8",
  ),
);
const {
  contract: _c,
  semanticDigest: _s,
  provenance: _p,
  provenanceDigest: _pd,
  ...fields
} = lock;
const descriptor = decodeSemanticDescriptor({
  ...fields,
  schema: "mirrors.model-interface-descriptor/v1",
});
const model: SuiteModel = {
  schema: "mirrors.suite-model/v1",
  nativeRepresentation: "mirrors.node-native/v1",
  semanticDigest: lock.semanticDigest,
  targetProfile: "mirrorecma-async-v1",
  stateComputerContractVersion: "mirrors.async-state-computer/v1",
  metadata: CounterModelInterface,
  descriptor,
  publicManifest: CounterPublicManifest,
  bindPublicPort: bindCounterAsyncPublicPort,
  bindLocal: (port, config) =>
    bindCounterAsyncPublicPort(
      {
        invoke: async (id, inputs, ctx) => port.actions[id]!(inputs, ctx),
        observe: async (ctx) => port.observe(ctx),
      },
      config,
    ),
};
const replay: ReplayPlan = {
  kind: "corpus",
  config: {
    specPath: resolve("examples/generated-counter/specs/Counter.tla"),
    invariant: "TraceComplete",
    lengthBound: 6,
    constInit: "CInit",
    paramVars: "parameters",
  },
  traces: [resolve("test/fixtures/model-interface/counter/counter.itf.json")],
};
const suite = defineSuite({
  id: "observer-fidelity",
  model,
  replay,
  acceptance: { requiredActions: ["Tick"] },
});
const matched = {
  proto_step: "spec_validated",
  result: "valid",
  modelInterface: {
    schema: "mirrors.model-interface-negotiation/v1",
    status: "matched",
    descriptorSchema: "mirrors.model-interface-descriptor/v1",
    semanticDigest: `sha256:${lock.semanticDigest}`,
  },
};
const script = [
  matched,
  {
    proto_step: "initial_state",
    action: "init",
    state: { count: { "#bigint": "0" } },
  },
  { proto_step: "step_ok" },
  {
    proto_step: "next_step",
    action: "tick",
    parameters: { parameters: { stride: { "#bigint": "2" } } },
  },
  { proto_step: "step_ok" },
  {
    proto_step: "next_step",
    action: "tick",
    parameters: { parameters: { stride: { "#bigint": "3" } } },
  },
  { proto_step: "step_ok" },
  { proto_step: "all_steps_done" },
];
class Script implements Transport {
  sent: string[] = [];
  send(line: string) {
    this.sent.push(line);
  }
  async close() {
    return 0;
  }
  async *[Symbol.asyncIterator]() {
    for (const message of script) yield JSON.stringify(message);
  }
}
function counter(faulty = false) {
  let count = 0n;
  const adapter: NativeSuiteAdapter & {
    trustedProbe: () => Promise<{ Count: bigint }>;
  } = {
    actions: {
      Initialize: () => {
        count = 0n;
      },
      Tick: (inputs) => {
        count += (inputs.Stride as bigint) - (faulty ? 1n : 0n);
      },
    },
    observe: () => ({ Count: count }),
    trustedProbe: async () => ({ Count: count }),
  };
  return adapter;
}
async function evaluate(adapter: NativeSuiteAdapter) {
  return runSuite(suite, {
    mirror: new Script(),
    implementation: (context) => {
      const dispose = context.deferCleanup(() => adapter.dispose?.());
      return { port: adapter, dispose };
    },
  });
}

test("observer exception and invalid observation remain implementation/codec failures, never mismatches", async () => {
  const thrown = await evaluate(withObserverControl(counter(), "throws"));
  expect(thrown).toMatchObject({
    outcome: "failed",
    failure: { kind: "implementation" },
  });
  const invalid = await evaluate(withObserverControl(counter(), "invalid"));
  expect(invalid).toMatchObject({
    outcome: "failed",
    failure: { kind: "codec", code: "observation_shape_mismatch" },
  });
  expect(
    [thrown, invalid].some((result) => result.outcome === "mismatch"),
  ).toBe(false);
});

test("shadow observer can pass replay while an independent probe exposes faulty real state", async () => {
  const actual = counter(true);
  const shadow = withObserverControl(actual, "shadow", [
    { Count: 0n },
    { Count: 2n },
    { Count: 5n },
  ]);
  const result = await evaluate(shadow);
  expect(result.outcome).toBe("passed");
  const probe = await runIndependentProbe(actual.trustedProbe, { Count: 5n });
  expect(probe).toMatchObject({
    status: "failed",
    code: "probe_mismatch",
    facts: { Count: { $bigint: "3" } },
  });
});

test("correct implementation passes replay and independent probe", async () => {
  const actual = counter(false);
  expect((await evaluate(actual)).outcome).toBe("passed");
  expect(
    await runIndependentProbe(actual.trustedProbe, { Count: 5n }),
  ).toMatchObject({ status: "passed" });
});

test("application-specific probes distinguish correct and faulty queue, transfer, and lease facts", async () => {
  for (const Type of [WorkQueue, BrokenWorkQueue]) {
    const queue = await Type.create(tmpdir());
    try {
      await queue.initialize();
      await queue.enqueue(1n);
      await queue.enqueue(1n);
      const probe = await runIndependentProbe(
        async () =>
          JSON.parse(
            await readFile(join(queue.directory, "queue.json"), "utf8"),
          ),
        { pending: ["1"], inFlight: "0", completed: [], failed: false },
      );
      expect(probe.status).toBe(Type === WorkQueue ? "passed" : "failed");
    } finally {
      await queue.dispose();
    }
  }
  const { createAdapter: createTransfer } = await import(
    "../examples/persistent-transfer/service.mjs"
  );
  for (const variant of ["correct", "corrupt-content"]) {
    const adapter = await createTransfer(variant);
    try {
      await adapter.actions.Initialize();
      await adapter.actions.Begin();
      await adapter.actions.Chunk({ Token: 1n, Offset: 0n, Value: 11n });
      const expected = {
        journal: {
          session: "1",
          phase: "open",
          committed: false,
          accepted: true,
        },
        payload: [11],
      };
      expect(
        (await runIndependentProbe(adapter.trustedProbe, expected)).status,
      ).toBe(variant === "correct" ? "passed" : "failed");
    } finally {
      await adapter.dispose();
    }
  }
  const { createAdapter: createLease } = await import(
    "../examples/lease-service/service.mjs"
  );
  for (const variant of ["correct", "overlapping-ownership"]) {
    const adapter = createLease(variant);
    try {
      adapter.actions.Initialize();
      adapter.actions.Acquire({ Client: 1n });
      adapter.actions.Acquire({ Client: 2n });
      const expected = {
        owners: [1n],
        epoch: 1n,
        expires: 3n,
        now: 0n,
        accepted: false,
        writes: 0n,
      };
      expect(
        (await runIndependentProbe(adapter.trustedProbe, expected)).status,
      ).toBe(variant === "correct" ? "passed" : "failed");
    } finally {
      await adapter.dispose();
    }
  }
});

test("probe definitions have stable identities and probe timeout stays distinct", async () => {
  expect(
    Object.values(probeDefinitions).every((definition) =>
      /^[a-f0-9]{64}$/.test(definition.sha256),
    ),
  ).toBe(true);
  expect(
    await runIndependentProbe(
      () => new Promise(() => {}),
      {},
      { budgetMs: 10 },
    ),
  ).toEqual({ status: "timed_out", code: "probe_timeout" });
});

test("actual mutation campaign marks a shadow observer inconclusive when independent facts diverge", async () => {
  const directory = resolve("examples/lease-service");
  const tracePath = join(directory, "artifacts/witness.itf.json");
  const traceBytes = await readFile(tracePath);
  const { createHash } = await import("node:crypto");
  const traceSha = createHash("sha256").update(traceBytes).digest("hex");
  const applicationConfig = JSON.parse(
    await readFile(join(directory, "application.json"), "utf8"),
  );
  const leaseSuite = defineLeaseSuite(
    join(directory, "specs/LeaseService.tla"),
    [
      { path: tracePath, sha256: traceSha },
      { path: tracePath, sha256: traceSha },
    ],
  );
  const app = {
    ...applicationConfig,
    directory,
    trace: tracePath,
    suite: leaseSuite,
    model: leaseSuite.model,
    localFaults: applicationConfig.faults,
    publicManifest: leaseSuite.model.publicManifest,
    config: leaseSuite.replay.config,
  };
  const trace = JSON.parse(traceBytes.toString("utf8"));
  const native = (state: any) => ({
    Owners: new Set(
      state.owners["#set"].map((item: any) => BigInt(item["#bigint"])),
    ),
    Epoch: BigInt(state.epoch["#bigint"]),
    Expires: BigInt(state.expires["#bigint"]),
    Now: BigInt(state.now["#bigint"]),
    Accepted: state.accepted,
    Writes: BigInt(state.writes["#bigint"]),
  });
  const shadowSnapshots = [...trace.states, ...trace.states].map(native);
  const identity = (id: string, value: string) => ({
    id,
    sha256: value.repeat(64),
  });
  const protectedInputs = {
    suite: identity("lease.suite", "1"),
    model: identity("lease.model", "2"),
    generatedInterface: identity("lease.interface", "3"),
    corpus: identity("lease.corpus", "4"),
    acceptance: identity("lease.acceptance", "5"),
    observer: identity("lease.observer", "6"),
    correctImplementation: identity("lease/correct", "7"),
    probes: [identity("lease-ownership-token-writes/v1", "8")],
    executionProfiles: [identity("local-suite/v1", "9")],
  };
  const campaign = {
    schema: "mirrorecma.mutation-campaign/v1" as const,
    id: "lease-shadow-negative/v1",
    revision: 1,
    evidenceLinks: {
      catalogSelectionRef: {
        schemaVersion: "mirrors.framework-catalog/v1" as const,
        selectionKind: "sha256" as const,
        selectionValue: "a".repeat(64),
      },
    },
    denominator: 1,
    protected: protectedInputs,
    mutants: [
      {
        id: "overlapping-ownership",
        implementation: identity("lease/overlapping-ownership", "b"),
        expected: {
          kind: "behavioral_mismatch" as const,
          code: "replay_mismatch" as const,
          traceIndex: 0,
          stateIndex: 2,
          action: "acquire",
        },
        resetPlanId: "lease.fresh/v1",
        probeIds: ["lease-ownership-token-writes/v1"],
        paths: {
          local: { support: "required" as const },
          gate: { support: "required" as const },
        },
      },
    ],
  };
  const report = await runMutationCampaign(campaign, {
    path: "local",
    observedProtected: protectedInputs,
    policy: {
      maxMutants: 4,
      totalBudgetMs: 30_000,
      perRunBudgetMs: 10_000,
      cleanupBudgetMs: 1_000,
    },
    evaluate: async (scenario) => {
      const result = await evaluateLocal(
        app,
        scenario.kind === "correct" ? "correct" : "overlapping-ownership",
        scenario.kind === "correct"
          ? {}
          : { observerControl: "shadow", shadowSnapshots },
      );
      return { suiteResult: result.suiteResult, probe: result.probe };
    },
  });
  expect(report).toMatchObject({
    status: "complete",
    acceptance: { status: "incomplete" },
    mutants: [
      {
        classification: "inconclusive",
        probe: {
          status: "failed",
          code: "probe_observer_divergence",
        },
      },
    ],
  });
});
