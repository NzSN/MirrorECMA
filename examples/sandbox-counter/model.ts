import { readFileSync } from "node:fs";
import {
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  createSandboxCompiledModel,
  decodeSemanticDescriptor,
  type SemanticDescriptor,
} from "../../src/index.js";
import {
  CounterAsyncStateComputerContractVersion,
  CounterAsyncTargetProfile,
  CounterModelInterface,
  CounterPublicManifest,
  bindCounterAsyncPublicPort,
} from "../../test/fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";

function loadCounterDescriptor(): SemanticDescriptor {
  const lock = JSON.parse(readFileSync(new URL(
    "../../test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json",
    import.meta.url,
  ), "utf8")) as Record<string, unknown>;
  const {
    contract: _contract,
    semanticDigest: _semanticDigest,
    provenance: _provenance,
    provenanceDigest: _provenanceDigest,
    ...descriptor
  } = lock;
  return decodeSemanticDescriptor({
    ...descriptor,
    schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  });
}

/** Compiler-owned model and mechanical stable-ID port adapter; it contains no SUT. */
export const SandboxCounterModel = createSandboxCompiledModel({
  metadata: CounterModelInterface,
  descriptor: loadCounterDescriptor(),
  adapterId: "counter.generated-async-v1",
  publicManifest: CounterPublicManifest,
  targetProfile: CounterAsyncTargetProfile,
  stateComputerContractVersion: CounterAsyncStateComputerContractVersion,
  bindPublicPort: bindCounterAsyncPublicPort,
  authoringBundle: {
    files: {
      "counter-port.d.ts": [
        "export interface CounterPort {",
        "  initialize(): Promise<void>;",
        "  tick(input: { readonly stride: bigint }): Promise<void>;",
        "  observe(): Promise<{ readonly count: bigint }>;",
        "}",
      ].join("\n"),
    },
  },
});
