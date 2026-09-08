import type { State } from "./protocol.js";

export interface ReplayContext {
  readonly signal: AbortSignal;
  /** One-based trace number; initialization is state zero. */
  readonly traceIndex: number;
  readonly stateIndex: number;
}

export type ReplayComputer = (
  action: string, params: State, prevState: State, context: ReplayContext,
) => State | Promise<State>;

export type AsyncStateComputer = (
  action: string, params: State, prevState: State, context: ReplayContext,
) => Promise<State>;

export interface ReplayOptions {
  readonly signal?: AbortSignal;
  readonly actionTimeoutMs?: number;
  readonly receiveTimeoutMs?: number;
}

export class ReplayControlError extends Error {
  constructor(
    readonly code: "replay_aborted" | "action_timeout" | "receive_timeout",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReplayControlError";
  }
}

export function validateReplayOptions(options: ReplayOptions): void {
  for (const key of ["actionTimeoutMs", "receiveTimeoutMs"] as const) {
    const value = options[key];
    // Node clamps larger timers to 1 ms; reject them instead of silently expiring.
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)) {
      throw new RangeError(`${key} must be positive and at most 2147483647 milliseconds`);
    }
  }
}

/** One terminal signal shared by receives and all action/observation calls. */
export class ReplayControl {
  private readonly controller = new AbortController();
  private readonly externalAbort: () => void;

  constructor(readonly options: ReplayOptions = {}) {
    validateReplayOptions(options);
    this.externalAbort = () => this.controller.abort(new ReplayControlError(
      "replay_aborted", "replay aborted", { cause: options.signal?.reason },
    ));
    options.signal?.addEventListener("abort", this.externalAbort, { once: true });
    if (options.signal?.aborted) this.externalAbort();
  }

  get signal(): AbortSignal { return this.controller.signal; }

  assertActive(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }

  async run<T>(kind: "action" | "receive", operation: () => T | PromiseLike<T>): Promise<T> {
    this.assertActive();
    const timeout = kind === "action" ? this.options.actionTimeoutMs : this.options.receiveTimeoutMs;
    const started = performance.now();
    const expire = () => this.controller.abort(new ReplayControlError(
      kind === "action" ? "action_timeout" : "receive_timeout",
      `${kind} timed out after ${timeout} ms`,
    ));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const terminal = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (timeout !== undefined) {
        timer = setTimeout(expire, timeout);
      }
    });
    try {
      // Install the terminal handler before invoking user code, including code
      // that aborts synchronously. Promise.race also consumes late rejections.
      const result = await Promise.race([terminal, Promise.resolve().then(() => {
        this.assertActive();
        return operation();
      })]);
      // Synchronous JS and continuous microtasks can delay timer delivery. A
      // completed over-budget action still must not send a state afterwards.
      if (timeout !== undefined && performance.now() - started >= timeout && !this.signal.aborted) expire();
      this.assertActive();
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  dispose(): void {
    this.options.signal?.removeEventListener("abort", this.externalAbort);
  }
}
