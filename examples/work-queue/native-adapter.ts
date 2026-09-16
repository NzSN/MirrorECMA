import type { WorkQueueNativeAdapter } from "./artifacts/bundle/WorkQueue.suite.js";
import type { WorkQueue } from "./queue.js";

/** Read the real persisted queue once per observation. The bundle owns codecs. */
export function nativeQueueAdapter(queue: WorkQueue): WorkQueueNativeAdapter {
  return {
    actions: {
      Initialize: (_inputs, { signal }) => queue.initialize(signal),
      Enqueue: ({ Item }, { signal }) => queue.enqueue(Item, signal),
      Start: (_inputs, { signal }) => queue.start(signal),
      Fail: (_inputs, { signal }) => queue.fail(signal),
      Retry: (_inputs, { signal }) => queue.retry(signal),
      Complete: (_inputs, { signal }) => queue.complete(signal),
      Reset: (_inputs, { signal }) => queue.reset(signal),
    },
    observe: async ({ signal }) => {
      const state = await queue.observe(signal);
      return { Pending: state.pending, InFlight: state.inFlight,
        Completed: state.completed, Failed: state.failed };
    },
    dispose: () => queue.dispose(),
  };
}
