import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeReproductionBundle,
  decodeSemanticDescriptor,
  defineSuite,
  replayReproduction,
  runSuite,
  type NativeSuiteAdapter,
  type ReplayPlan,
  type ReproductionBundle,
  type ReproductionReplayResult,
  type SuiteModel,
  type Transport,
} from "../../src/index.js";
import {
  CounterModelInterface,
  CounterPublicManifest,
  bindCounterAsyncPublicPort,
} from "../fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";

const lock = JSON.parse(
  readFileSync(
    resolve(
      "test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json",
    ),
    "utf8",
  ),
);
const {
  contract: _contract,
  semanticDigest: _semanticDigest,
  provenance: _provenance,
  provenanceDigest: _provenanceDigest,
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
        invoke: async (id, inputs, context) =>
          port.actions[id]!(inputs, context),
        observe: async (context) => port.observe(context),
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
const suite = defineSuite({ id: "counter-reproduction", model, replay });
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
const messages = [
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
  {
    proto_step: "step_mismatch",
    action: "tick",
    expected: { count: { "#bigint": "2" } },
    actual: { count: { "#bigint": "1" } },
  },
];
class Script implements Transport {
  send(_line: string): void {}
  async close(): Promise<number> {
    return 0;
  }
  async *[Symbol.asyncIterator]() {
    for (const message of messages) yield JSON.stringify(message);
  }
}
export interface LifecycleCounts {
  factories: number;
  disposals: number;
}
export function counterBundle(raw: string): ReproductionBundle {
  const value = JSON.parse(raw);
  value.signature.primary = {
    kind: "behavioral_mismatch",
    code: "replay_mismatch",
    traceIndex: 0,
    stateIndex: 1,
    action: "tick",
  };
  return decodeReproductionBundle(JSON.stringify(value));
}
export async function replayFaultyCounter(
  bundle: ReproductionBundle,
  counts: LifecycleCounts,
  signal?: AbortSignal,
): Promise<ReproductionReplayResult> {
  return replayReproduction(bundle, {
    expectedIdentities: bundle.identities,
    expectedCatalogSelection: bundle.evidenceLinks.catalogSelectionRef,
    validateEvidenceLinks: () => {},
    admittedResolvers: new Set(["fixture-private-store/v1"]),
    resolveExternal: () => "EXTERNAL_PRIVATE_CANARY",
    signal,
    evaluate: async (runSignal) =>
      runSuite(suite, {
        mirror: new Script(),
        signal: runSignal,
        implementation: (context) => {
          counts.factories++;
          let count = 0n;
          const adapter: NativeSuiteAdapter = {
            actions: {
              Initialize: () => {
                count = 0n;
              },
              Tick: (inputs) => {
                count += (inputs.Stride as bigint) - 1n;
              },
            },
            observe: () => ({ Count: count }),
          };
          const dispose = context.deferCleanup(() => {
            counts.disposals++;
          });
          return { port: adapter, dispose };
        },
      }),
  });
}
