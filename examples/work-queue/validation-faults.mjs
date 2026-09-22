import { tmpdir } from "node:os";

/** Domain-only fault constructors shared by local and frozen Gate fixtures. */
export async function createQueueVariant(
  WorkQueue,
  variant = "correct",
  parent = tmpdir(),
) {
  class DuplicateAcceptsQueue extends WorkQueue {
    admitEnqueue(item) {
      return item;
    }
  }
  class EnqueueDropsQueue extends WorkQueue {
    admitEnqueue() {
      return null;
    }
  }
  class EnqueueInFlightQueue extends WorkQueue {
    admitEnqueue(item, state) {
      return item === state.inFlight ? item : super.admitEnqueue(item, state);
    }
  }
  class StartStaleQueue extends WorkQueue {
    beginWork(state) {
      if (state.inFlight !== 0n || state.pending.length === 0)
        throw new Error("Start requires an idle worker and a pending job");
      state.pending.shift();
      state.inFlight = 2n;
      state.failed = false;
    }
  }
  class FailDoesNotMarkQueue extends WorkQueue {
    markFailed() {
      return false;
    }
  }
  class RetryDoesNotClearQueue extends WorkQueue {
    clearFailed() {
      return true;
    }
  }
  class CompleteKeepsInFlightQueue extends WorkQueue {
    finishWork(state) {
      state.completed.add(state.inFlight);
    }
  }
  class CompleteStaleQueue extends WorkQueue {
    finishWork(state) {
      state.completed.add(9n);
      state.inFlight = 0n;
    }
  }
  class ResetLeavesStateQueue extends WorkQueue {
    async initialize(signal) {
      try {
        await this.observe(signal);
      } catch {
        await super.initialize(signal);
      }
    }
  }
  const Type = {
    correct: WorkQueue,
    "duplicate-accepts": DuplicateAcceptsQueue,
    "enqueue-drops": EnqueueDropsQueue,
    "enqueue-in-flight": EnqueueInFlightQueue,
    "start-stale": StartStaleQueue,
    "fail-does-not-mark": FailDoesNotMarkQueue,
    "retry-does-not-clear": RetryDoesNotClearQueue,
    "complete-keeps-in-flight": CompleteKeepsInFlightQueue,
    "complete-stale": CompleteStaleQueue,
    "reset-leaves-state": ResetLeavesStateQueue,
  }[variant];
  if (!Type) throw new Error("unknown implementation variant");
  return Type.create(parent);
}
