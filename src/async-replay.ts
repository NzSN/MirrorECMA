import type { State } from "./protocol.js";

/** Absolute monotonic time in milliseconds, in the `performance.now()` time origin. */
export interface ReplayContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export interface ReplayInput {
  readonly action: string;
  readonly payload: State;
  readonly previous: State;
}

export type AsyncStateComputer = (
  input: ReplayInput,
  context: ReplayContext,
) => Promise<State>;

export type ReplayDeadlineStage = "registration" | "step" | "receive" | "close";

export class ReplayCancelledError extends Error {
  readonly code = "replay_cancelled" as const;

  constructor(readonly reason?: unknown) {
    super("replay cancelled", reason === undefined ? undefined : { cause: reason });
    this.name = "ReplayCancelledError";
  }
}

export class ReplayDeadlineError extends Error {
  readonly code = "replay_deadline_exceeded" as const;

  constructor(readonly stage: ReplayDeadlineStage, readonly timeoutMs: number) {
    super(`${stage} deadline exceeded after ${timeoutMs}ms`);
    this.name = "ReplayDeadlineError";
  }
}

export const DEFAULT_REPLAY_DEADLINES = Object.freeze({
  registrationMs: 60_000,
  stepMs: 10_000,
  receiveMs: 60_000,
});

export interface ReplayDeadlines {
  readonly registrationMs: number;
  readonly stepMs: number;
  readonly receiveMs: number;
}

export function normalizeReplayDeadlines(
  deadlines: Partial<ReplayDeadlines> | undefined,
): ReplayDeadlines {
  const result = Object.freeze({ ...DEFAULT_REPLAY_DEADLINES, ...deadlines });
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) {
      throw new RangeError(`${name} must be a positive integer no greater than 2147483647`);
    }
  }
  return result;
}

export function throwIfReplayCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ReplayCancelledError(signal.reason);
}

/**
 * Await one operation with cancellation and a bounded monotonic deadline.
 * The original promise always has a rejection handler before the race settles.
 */
export function awaitReplayOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  stage: ReplayDeadlineStage,
): Promise<T> {
  return awaitReplayOperationUntil(
    operation,
    signal,
    performance.now() + timeoutMs,
    timeoutMs,
    stage,
  );
}

function awaitReplayOperationUntil<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number,
  timeoutMs: number,
  stage: ReplayDeadlineStage,
): Promise<T> {
  operation.catch(() => {});
  throwIfReplayCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => {
      const reason = signal?.reason;
      reject(reason instanceof ReplayDeadlineError ? reason : new ReplayCancelledError(reason));
    });
    const remaining = Math.max(0, deadline - performance.now());
    const timer = setTimeout(
      () => finish(() => reject(new ReplayDeadlineError(stage, timeoutMs))),
      Math.ceil(remaining),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    operation.then(
      (value) => finish(() => {
        if (signal?.aborted) {
          const reason = signal.reason;
          reject(reason instanceof ReplayDeadlineError
            ? reason
            : new ReplayCancelledError(reason));
        } else if (performance.now() >= deadline) {
          reject(new ReplayDeadlineError(stage, timeoutMs));
        } else {
          resolve(value);
        }
      }),
      (error) => finish(() => {
        if (signal?.aborted) {
          const reason = signal.reason;
          reject(reason instanceof ReplayDeadlineError
            ? reason
            : new ReplayCancelledError(reason));
        } else if (performance.now() >= deadline) {
          reject(new ReplayDeadlineError(stage, timeoutMs));
        } else {
          reject(error);
        }
      }),
    );
  });
}

export function invokeAsyncComputer(
  computer: AsyncStateComputer,
  input: ReplayInput,
  signal: AbortSignal | undefined,
  stepMs: number,
): Promise<State> {
  throwIfReplayCancelled(signal);
  const deadline = performance.now() + stepMs;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let pending: Promise<State>;
  try {
    pending = Promise.resolve(computer(
      Object.freeze({ ...input }),
      Object.freeze({ signal: controller.signal, deadline }),
    ));
  } catch (error) {
    controller.abort(error);
    signal?.removeEventListener("abort", onAbort);
    throw error;
  }
  const timer = setTimeout(
    () => controller.abort(new ReplayDeadlineError("step", stepMs)),
    Math.max(0, Math.ceil(deadline - performance.now())),
  );
  return awaitReplayOperationUntil(
    pending,
    controller.signal,
    deadline,
    stepMs,
    "step",
  ).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
}
