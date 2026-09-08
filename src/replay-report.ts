import type { DiffHint, State } from "./protocol.js";

export interface ReplayDiagnosticReference {
  readonly family: string;
  readonly reference: string;
}

export interface ReplayReport {
  readonly status: "completed";
  readonly acceptedTraces: number;
  readonly acceptedSteps: number;
  readonly actionCoverage: Readonly<Record<string, number>>;
  readonly diagnostics: readonly ReplayDiagnosticReference[];
}

export class ReplayMismatchError extends Error {
  readonly code = "replay_mismatch" as const;

  constructor(
    message: string,
    readonly expected: State,
    readonly actual: State,
    readonly hints: readonly DiffHint[],
    readonly traceIndex: number,
    readonly stepIndex: number,
    readonly action: string,
  ) {
    super(message);
    this.name = "ReplayMismatchError";
  }
}

/** Preserves arbitrary JavaScript rejection values as an actual runner error. */
export class ReplayThrownValueError extends Error {
  readonly code = "replay_thrown_value" as const;

  constructor(readonly thrownValue: unknown) {
    super("replay callback rejected with a non-Error value", { cause: thrownValue });
    this.name = "ReplayThrownValueError";
  }
}

export class ReplayCleanupError extends Error {
  readonly code = "replay_cleanup_failed" as const;
  readonly stage = "close" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReplayCleanupError";
  }
}

const cleanupFailures = new WeakMap<Error, unknown>();

export function normalizeReplayFailure(error: unknown): Error {
  return error instanceof Error ? error : new ReplayThrownValueError(error);
}

/** Record cleanup evidence without replacing the primary replay outcome. */
export function retainReplayCleanupFailure(primary: Error, cleanup: unknown): void {
  cleanupFailures.set(primary, cleanup);
}

export function replayCleanupFailure(primary: unknown): unknown | undefined {
  return primary instanceof Error ? cleanupFailures.get(primary) : undefined;
}

export function stableCoverage(
  coverage: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  const result = Object.create(null) as Record<string, number>;
  for (const key of Object.keys(coverage ?? {}).sort()) result[key] = coverage![key]!;
  return Object.freeze(result);
}

export function replayReport(
  acceptedTraces: number,
  acceptedSteps: number,
  coverage?: Readonly<Record<string, number>>,
): ReplayReport {
  return Object.freeze({
    status: "completed" as const,
    acceptedTraces,
    acceptedSteps,
    actionCoverage: stableCoverage(coverage),
    diagnostics: Object.freeze([]),
  });
}
