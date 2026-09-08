import { encodeState, renderDiffHints, type DiffHint, type State } from "./protocol.js";

export interface ReplayFailure {
  readonly code: string;
  readonly message: string;
  readonly traceIndex?: number;
  readonly stateIndex?: number;
  readonly action?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly expected?: Readonly<Record<string, unknown>>;
  readonly actual?: Readonly<Record<string, unknown>>;
  readonly hints?: readonly Readonly<Record<string, unknown>>[];
}

/** JSON-safe aggregate snapshot. State zero is initialization, not a transition. */
export interface ReplayReport {
  readonly schema: "mirrorecma.replay-report/v1";
  readonly status: "passed" | "failed";
  readonly interfaceDigest?: string;
  readonly durationMs: number;
  readonly tracesStarted: number;
  readonly tracesCompleted: number;
  readonly statesReported: number;
  readonly statesMatched: number;
  readonly stepsCompleted: number;
  readonly actionCounts: Readonly<Record<string, number>>;
  readonly sequenceCounts: readonly { readonly from: string; readonly to: string; readonly count: number }[];
  /** Distinct-name caps bound aggregate memory even for unrestricted legacy callbacks. */
  readonly coverage: {
    readonly actionLimit: number;
    readonly sequenceLimit: number;
    readonly droppedActionEvents: number;
    readonly droppedSequenceEvents: number;
    readonly truncated: boolean;
  };
  readonly failure?: ReplayFailure;
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot<T>(value: T): T { return freezeDeep(structuredClone(value)); }

function encodeHint(hint: DiffHint): Readonly<Record<string, unknown>> {
  return {
    kind: hint.kind,
    path: hint.path,
    ...("expected" in hint ? { expected: encodeState({ value: hint.expected }).value } : {}),
    ...("actual" in hint ? { actual: encodeState({ value: hint.actual }).value } : {}),
  };
}

const errorReports = new WeakMap<object, ReplayReport>();

/** Retains the original exception identity, including frozen application errors. */
export function replayReportFromError(error: unknown): ReplayReport | undefined {
  return isObject(error) ? errorReports.get(error) : undefined;
}

export function attachReplayReport(error: unknown, report: ReplayReport): void {
  if (isObject(error)) errorReports.set(error, report);
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

export class ReplayMismatchError extends Error {
  readonly code = "step_mismatch";
  readonly params: State;
  readonly expected: State;
  readonly actual: State;
  readonly hints: DiffHint[];

  constructor(
    readonly action: string,
    params: State,
    expected: State,
    actual: State,
    hints: DiffHint[] | undefined,
    readonly traceIndex: number,
    readonly stateIndex: number,
  ) {
    const detail = hints?.length ? renderDiffHints(hints)
      : `expected ${JSON.stringify(encodeState(expected))}, got ${JSON.stringify(encodeState(actual))}`;
    super(`step mismatch on action "${action}" with param ${JSON.stringify(encodeState(params))}: ${detail}`);
    this.name = "ReplayMismatchError";
    this.params = snapshot(params);
    this.expected = snapshot(expected);
    this.actual = snapshot(actual);
    this.hints = snapshot(hints ?? []);
  }

  get report(): ReplayReport | undefined { return replayReportFromError(this); }

  toJSON(): ReplayFailure & { readonly report?: ReplayReport } {
    return { ...describeReplayFailure(this), ...(this.report === undefined ? {} : { report: this.report }) };
  }
}

export function describeReplayFailure(error: unknown): ReplayFailure {
  // Rejection values belong to application code: even instanceof, property
  // reads, and string coercion can throw (including by throwing the same object).
  // Diagnostics must never replace that rejection or skip lifecycle cleanup.
  try {
    if (error instanceof ReplayMismatchError) {
      return snapshot({
        code: error.code, message: error.message, action: error.action,
        traceIndex: error.traceIndex, stateIndex: error.stateIndex,
        params: encodeState(error.params), expected: encodeState(error.expected),
        actual: encodeState(error.actual), hints: error.hints.map(encodeHint),
      });
    }
  } catch { /* Use a safe minimal diagnostic if a subclass or proxy traps. */ }
  let code = "replay_failed";
  let message = "replay failed (unprintable rejection)";
  try {
    if (isObject(error) && "code" in error) {
      const candidate: unknown = error.code;
      if (typeof candidate === "string") code = candidate;
    }
  } catch { /* Keep the stable generic code. */ }
  try {
    const candidate: unknown = isObject(error) && "message" in error ? error.message : undefined;
    message = typeof candidate === "string" ? candidate : String(error);
  } catch { /* Keep the printable generic message. */ }
  return Object.freeze({ code, message });
}

export function failedReplayReport(report: ReplayReport, error: unknown): ReplayReport {
  return snapshot({ ...report, status: "failed", failure: describeReplayFailure(error) });
}

const ACTION_LIMIT = 256;
const SEQUENCE_LIMIT = 1024;

/** Internal aggregate collector: bounded even when every received action is unique. */
export class ReplayRecorder {
  private readonly start = performance.now();
  private tracesStarted = 0;
  private tracesCompleted = 0;
  private statesReported = 0;
  private statesMatched = 0;
  private stepsCompleted = 0;
  private stateIndex = 0;
  private pending = false;
  private previousAction: string | undefined;
  private droppedActionEvents = 0;
  private droppedSequenceEvents = 0;
  private readonly actions = new Map<string, number>();
  private readonly sequences = new Map<string, { from: string; to: string; count: number }>();

  constructor(private readonly interfaceDigest?: string) {}

  get position(): { traceIndex: number; stateIndex: number } {
    return { traceIndex: this.tracesStarted, stateIndex: this.stateIndex };
  }

  begin(initial: boolean): void {
    this.acknowledge();
    if (initial) {
      if (this.tracesStarted > 0) this.tracesCompleted += 1;
      this.tracesStarted += 1;
      this.stateIndex = 0;
      this.previousAction = undefined;
    } else {
      this.stateIndex += 1;
    }
  }

  reported(action: string): void {
    this.statesReported += 1;
    this.pending = true;
    if (this.actions.has(action) || this.actions.size < ACTION_LIMIT) {
      this.actions.set(action, (this.actions.get(action) ?? 0) + 1);
    } else {
      this.droppedActionEvents += 1;
    }
    if (this.previousAction !== undefined) {
      const key = JSON.stringify([this.previousAction, action]);
      const old = this.sequences.get(key);
      if (old !== undefined || this.sequences.size < SEQUENCE_LIMIT) {
        this.sequences.set(key, { from: this.previousAction, to: action, count: (old?.count ?? 0) + 1 });
      } else {
        this.droppedSequenceEvents += 1;
      }
    }
    this.previousAction = action;
  }

  acknowledge(): void {
    if (!this.pending) return;
    this.pending = false;
    this.statesMatched += 1;
    if (this.stateIndex > 0) this.stepsCompleted += 1;
  }

  complete(): ReplayReport {
    this.acknowledge();
    this.tracesCompleted = this.tracesStarted;
    return this.report();
  }

  report(error?: unknown): ReplayReport {
    // A rejection with `undefined` is still a failure. Only an omitted argument
    // denotes the successful snapshot requested by complete().
    const failed = arguments.length > 0;
    return snapshot({
      schema: "mirrorecma.replay-report/v1" as const,
      status: failed ? "failed" as const : "passed" as const,
      ...(this.interfaceDigest === undefined ? {} : { interfaceDigest: this.interfaceDigest }),
      durationMs: Math.max(0, performance.now() - this.start),
      tracesStarted: this.tracesStarted, tracesCompleted: this.tracesCompleted,
      statesReported: this.statesReported, statesMatched: this.statesMatched,
      stepsCompleted: this.stepsCompleted,
      actionCounts: Object.fromEntries(this.actions),
      sequenceCounts: [...this.sequences.values()],
      coverage: {
        actionLimit: ACTION_LIMIT, sequenceLimit: SEQUENCE_LIMIT,
        droppedActionEvents: this.droppedActionEvents,
        droppedSequenceEvents: this.droppedSequenceEvents,
        truncated: this.droppedActionEvents > 0 || this.droppedSequenceEvents > 0,
      },
      ...(failed ? { failure: describeReplayFailure(error) } : {}),
    });
  }
}
