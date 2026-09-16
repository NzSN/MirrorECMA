import { awaitReplayOperation } from "./async-replay.js";
/** A trusted boundary marker; arbitrary implementation exceptions cannot create it. */
export class SuiteTransportError extends Error {
  readonly code = "suite_transport_failed";
  constructor(cause: unknown) { super("owned model transport failed", {cause}); }
}
/** Internal opt-in lifetime for suites; low-level replay keeps its existing defaults. */
export class SuiteLifetime {
  readonly pending = new Set<Promise<unknown>>();
  cleanupDeadline: number | undefined;
  cleanupFailed = false;
  unconfirmed = false;
  sealed = false;
  constructor(readonly cleanupMs: number) {}
  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }
  startCleanup(): void {
    this.sealed = true;
    this.cleanupDeadline ??= performance.now() + this.cleanupMs;
  }
  async wait<T>(operation: Promise<T>): Promise<T> {
    this.startCleanup();
    return awaitReplayOperation(operation, undefined, Math.max(1, Math.ceil(this.cleanupDeadline! - performance.now())), "close");
  }
  async join(): Promise<void> {
    this.startCleanup();
    try {
      while (this.pending.size) await this.wait(Promise.allSettled([...this.pending]));
    } catch { this.unconfirmed = true; }
  }
}
