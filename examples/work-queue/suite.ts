import { defineSuite, type CorpusTrace } from "mirrorecma";
import { WorkQueueModel } from "./artifacts/bundle/WorkQueue.suite.js";

export const model = WorkQueueModel;

/** One inert declaration is used by both local replay and restricted Gate providers. */
export function defineApplicationSuite(modelPath: string, traces: readonly CorpusTrace[]) {
  return defineSuite({
    id: "work-queue.acceptance/v2",
    adapterId: "work-queue.validation/v1",
    model,
    replay: {
      kind: "corpus",
      config: { specPath: modelPath, initPredicate: "Init", nextPredicate: "WitnessNext",
        invariant: "TraceComplete", lengthBound: 15, paramVars: "parameters" },
      traces,
      provenance: { interfaceDigest: model.semanticDigest, modelSha256: model.provenance!.modelSha256 },
    },
    acceptance: {
      requiredActions: ["Complete", "Enqueue", "Fail", "Reset", "Retry", "Start"],
      requiredPairs: [["Enqueue", "Enqueue"], ["Fail", "Retry"], ["Retry", "Complete"], ["Reset", "Enqueue"]],
    },
  });
}
