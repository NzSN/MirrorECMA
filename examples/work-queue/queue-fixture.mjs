import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Shared actual-state observer and independent persisted-state probe. */
export function createQueueFixtureAdapter(queue) {
  return {
    actions: {
      Initialize: (_inputs, context) => queue.initialize(context?.signal),
      Enqueue: ({ Item }, context) => queue.enqueue(Item, context?.signal),
      Start: (_inputs, context) => queue.start(context?.signal),
      Fail: (_inputs, context) => queue.fail(context?.signal),
      Retry: (_inputs, context) => queue.retry(context?.signal),
      Complete: (_inputs, context) => queue.complete(context?.signal),
      Reset: (_inputs, context) => queue.reset(context?.signal),
    },
    observe: async (context) => {
      const state = await queue.observe(context?.signal);
      return {
        Pending: state.pending,
        InFlight: state.inFlight,
        Completed: state.completed,
        Failed: state.failed,
      };
    },
    trustedProbe: async () =>
      JSON.parse(await readFile(join(queue.directory, "queue.json"), "utf8")),
    dispose: () => queue.dispose(),
  };
}
