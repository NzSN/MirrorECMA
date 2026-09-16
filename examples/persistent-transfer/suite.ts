import { defineSuite, type CorpusTrace } from "mirrorecma";
import { PersistentTransferModel } from "./artifacts/bundle/PersistentTransfer.suite.js";

export const model = PersistentTransferModel;

/** One inert declaration is used by both local replay and restricted Gate providers. */
export function defineApplicationSuite(modelPath: string, traces: readonly CorpusTrace[]) {
  return defineSuite({
    id: "persistent-transfer.acceptance/v2",
    adapterId: "persistent-transfer.validation/v1",
    model,
    replay: {
      kind: "corpus",
      config: { specPath: modelPath, initPredicate: "Init", nextPredicate: "WitnessNext",
        invariant: "TraceComplete", lengthBound: 15, paramVars: "parameters" },
      traces,
      provenance: { interfaceDigest: model.semanticDigest, modelSha256: model.provenance!.modelSha256 },
    },
    acceptance: {
      requiredActions: ["Begin", "Cancel", "Chunk", "Commit", "Pause", "Restart", "Resume"],
      requiredPairs: [["Chunk", "Chunk"], ["Pause", "Restart"], ["Cancel", "Begin"]],
    },
  });
}
