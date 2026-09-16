import { defineSuite, type CorpusTrace } from "mirrorecma";
import { LeaseServiceModel } from "./artifacts/bundle/LeaseService.suite.js";

export const model = LeaseServiceModel;

/** One inert declaration is used by both local replay and restricted Gate providers. */
export function defineApplicationSuite(modelPath: string, traces: readonly CorpusTrace[]) {
  return defineSuite({
    id: "lease-service.acceptance/v2",
    adapterId: "lease-service.validation/v1",
    model,
    replay: {
      kind: "corpus",
      config: { specPath: modelPath, initPredicate: "Init", nextPredicate: "WitnessNext",
        invariant: "TraceComplete", lengthBound: 10, paramVars: "parameters" },
      traces,
      provenance: { interfaceDigest: model.semanticDigest, modelSha256: model.provenance!.modelSha256 },
    },
    acceptance: {
      requiredActions: ["Acquire", "Advance", "Release", "Renew", "Write"],
      requiredPairs: [["Acquire", "Acquire"], ["Advance", "Write"], ["Release", "Renew"]],
    },
  });
}
