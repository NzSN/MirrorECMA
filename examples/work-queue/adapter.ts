import {
  DescriptorCache,
  decodeContractV1,
  semanticDigestFromHex,
  type AsyncDynamicHandlerRegistry,
  type DynamicHandlerFactorySelection,
  type ReplayReport,
} from "../../src/index.js";
import {
  WorkQueueModelInterface,
  WorkQueueSemanticDigest,
} from "./artifacts/generated/WorkQueueMirror.generated.js";
import { WorkQueue } from "./queue.js";

export const requiredActions = ["init", "enqueue", "start", "fail", "retry", "complete", "reset"] as const;
export const requiredPairs = [
  ["enqueue", "enqueue"], ["fail", "retry"], ["retry", "complete"], ["reset", "enqueue"],
] as const;

/** Inert selection: the runner calls createQueue only after descriptor validation. */
export function createQueueSelection(
  createQueue: () => Promise<WorkQueue> = () => WorkQueue.create(),
): DynamicHandlerFactorySelection {
  const semanticDigest = semanticDigestFromHex(WorkQueueSemanticDigest);
  return {
    mode: "dynamic",
    policy: "require",
    semanticDigest,
    contract: decodeContractV1(WorkQueueModelInterface.contract),
    descriptorCache: new DescriptorCache(),
    createRegistry: async () => {
      const queue = await createQueue();
      const registry: AsyncDynamicHandlerRegistry = {
        semanticDigest,
        actions: {
          Initialize: (_inputs, { signal }) => queue.initialize(signal),
          Enqueue: ({ Item }, { signal }) => {
            if (typeof Item !== "bigint") throw new TypeError("Enqueue.Item must be bigint");
            return queue.enqueue(Item, signal);
          },
          Start: (_inputs, { signal }) => queue.start(signal),
          Fail: (_inputs, { signal }) => queue.fail(signal),
          Retry: (_inputs, { signal }) => queue.retry(signal),
          Complete: (_inputs, { signal }) => queue.complete(signal),
          Reset: (_inputs, { signal }) => queue.reset(signal),
        },
        observations: {
          Pending: async ({ signal }) => (await queue.observe(signal)).pending,
          InFlight: async ({ signal }) => (await queue.observe(signal)).inFlight,
          Completed: async ({ signal }) => [...(await queue.observe(signal)).completed],
          Failed: async ({ signal }) => (await queue.observe(signal)).failed,
        },
      };
      return { execution: "async", registry, dispose: () => queue.dispose() };
    },
  };
}

export function assertQueueCoverage(report: ReplayReport): void {
  for (const action of requiredActions) {
    if (!(report.actionCounts[action]! > 0)) throw new Error(`Missing queue action coverage: ${action}`);
  }
  for (const [from, to] of requiredPairs) {
    if (!report.sequenceCounts.some((pair) => pair.from === from && pair.to === to && pair.count > 0)) {
      throw new Error(`Missing queue action-pair coverage: ${from} -> ${to}`);
    }
  }
}
