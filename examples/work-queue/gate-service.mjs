// This module is copied beside compiler-emitted queue.js in the frozen submission.
import { WorkQueue } from './queue.js';

class DuplicateQueue extends WorkQueue { admitEnqueue(item) { return item; } }
class DroppingQueue extends WorkQueue { admitEnqueue() { return null; } }
class StuckRetryQueue extends WorkQueue { clearFailed() { return true; } }

export async function createAdapter(variant = 'correct') {
  const Type = { correct: WorkQueue, 'duplicate-accepts': DuplicateQueue,
    'enqueue-drops': DroppingQueue, 'retry-does-not-clear': StuckRetryQueue }[variant];
  if (!Type) throw new Error('unknown implementation variant');
  const queue = await Type.create();
  return {
    actions: {
      Initialize: () => queue.initialize(), Enqueue: ({ Item }) => queue.enqueue(Item),
      Start: () => queue.start(), Fail: () => queue.fail(), Retry: () => queue.retry(),
      Complete: () => queue.complete(), Reset: () => queue.reset(),
    },
    observe: async () => {
      const state = await queue.observe();
      return { Pending: state.pending, InFlight: state.inFlight, Completed: state.completed, Failed: state.failed };
    },
    dispose: () => queue.dispose(),
  };
}
