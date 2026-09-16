import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  replayReportFromError,
  runClientWithTracesNegotiatedWithReport,
  type ApalacheConfig,
  type ReplayFailure,
  type ReplayReport,
} from "../../src/index.js";
import { assertQueueCoverage, createQueueSelection } from "./adapter.js";
import { WorkQueue, type QueueSnapshot } from "./queue.js";

export interface FirstMismatchExpectation {
  /** One-based trace index; the harness replays the same witness twice in one session. */
  readonly traceIndex: number;
  /** Witness state index as reported by the replay report; state 1 is the first transition. */
  readonly stateIndex: number;
  readonly action: string;
  readonly code: "step_mismatch" | "replay_mismatch";
}

export interface SeededFault {
  readonly name: string;
  /** One-line description of the mutation; the pointer is evaluated by the inherited logic. */
  readonly mutation: string;
  /** Where the deterministic witness must first reject the faulty implementation. */
  readonly expect: FirstMismatchExpectation;
  readonly create: (parentDirectory?: string) => Promise<WorkQueue>;
}

/** Repeated Enqueue is appended even though the job is already pending or in flight. */
class DuplicateAcceptsQueue extends WorkQueue {
  protected override admitEnqueue(item: bigint): bigint | null { return item; }
}

/** The first Enqueue stores nothing, so the job is lost before the worker starts. */
class EnqueueDropsQueue extends WorkQueue {
  protected override admitEnqueue(): bigint | null { return null; }
}

/** Enqueue accepts a job that is already in flight. */
class EnqueueInFlightQueue extends WorkQueue {
  protected override admitEnqueue(item: bigint, state: QueueSnapshot): bigint | null {
    return item === state.inFlight ? item : super.admitEnqueue(item, state);
  }
}

/** Start marks an ID that was never in the pending queue. */
class StartStaleQueue extends WorkQueue {
  protected override beginWork(state: { inFlight: bigint; pending: bigint[]; failed: boolean }): void {
    if (state.inFlight !== 0n || state.pending.length === 0) {
      throw new Error("Start requires an idle worker and a pending job");
    }
    state.pending.shift();
    state.inFlight = 2n;
    state.failed = false;
  }
}

/** Fail records the request but leaves the failed flag false. */
class FailDoesNotMarkQueue extends WorkQueue {
  protected override markFailed(): boolean { return false; }
}

class RetryDoesNotClearQueue extends WorkQueue {
  protected override clearFailed(): boolean { return true; }
}

/** Complete records the job but never frees the worker. */
class CompleteKeepsInFlightQueue extends WorkQueue {
  protected override finishWork(state: { inFlight: bigint; completed: Set<bigint> }): void {
    state.completed.add(state.inFlight);
  }
}

/** Complete records an ID that was never run. */
class CompleteStaleQueue extends WorkQueue {
  protected override finishWork(state: { inFlight: bigint; completed: Set<bigint> }): void {
    state.completed.add(9n);
    state.inFlight = 0n;
  }
}

/** Initialize does not clear the store, so a later trace starts from stale state. */
class ResetLeavesStateQueue extends WorkQueue {
  override async initialize(signal?: AbortSignal): Promise<void> {
    try {
      await this.observe(signal);
    } catch {
      await super.initialize(signal);
    }
  }
}

export const seededFaults: readonly SeededFault[] = [
  {
    name: "duplicate-accepts",
    mutation: "admitEnqueue() always stores the item, so a repeated Enqueue is appended instead of ignored.",
    expect: { traceIndex: 1, stateIndex: 2, action: "enqueue", code: "step_mismatch" },
    create: (parent) => DuplicateAcceptsQueue.create(parent ?? tmpdir()),
  },
  {
    name: "enqueue-drops",
    mutation: "admitEnqueue() always returns null, so the first Enqueue stores nothing.",
    expect: { traceIndex: 1, stateIndex: 1, action: "enqueue", code: "step_mismatch" },
    create: (parent) => EnqueueDropsQueue.create(parent ?? tmpdir()),
  },
  {
    name: "enqueue-in-flight",
    mutation: "admitEnqueue() admits a job that is already in flight, so it also stays pending.",
    expect: { traceIndex: 1, stateIndex: 5, action: "enqueue", code: "step_mismatch" },
    create: (parent) => EnqueueInFlightQueue.create(parent ?? tmpdir()),
  },
  {
    name: "start-stale",
    mutation: "beginWork() marks job 2 in flight while job 1 was the queued head.",
    expect: { traceIndex: 1, stateIndex: 4, action: "start", code: "step_mismatch" },
    create: (parent) => StartStaleQueue.create(parent ?? tmpdir()),
  },
  {
    name: "fail-does-not-mark",
    mutation: "markFailed() stores false, so the failed job looks runnable on Retry.",
    expect: { traceIndex: 1, stateIndex: 6, action: "fail", code: "step_mismatch" },
    create: (parent) => FailDoesNotMarkQueue.create(parent ?? tmpdir()),
  },
  {
    name: "retry-does-not-clear",
    mutation: "clearFailed() leaves the job failed after retry.",
    expect: { traceIndex: 1, stateIndex: 7, action: "retry", code: "step_mismatch" },
    create: (parent) => RetryDoesNotClearQueue.create(parent ?? tmpdir()),
  },
  {
    name: "complete-keeps-in-flight",
    mutation: "finishWork() returns the job but leaves it in flight after Complete.",
    expect: { traceIndex: 1, stateIndex: 8, action: "complete", code: "step_mismatch" },
    create: (parent) => CompleteKeepsInFlightQueue.create(parent ?? tmpdir()),
  },
  {
    name: "complete-stale",
    mutation: "finishWork() records job 9 as completed instead of the running job.",
    expect: { traceIndex: 1, stateIndex: 8, action: "complete", code: "step_mismatch" },
    create: (parent) => CompleteStaleQueue.create(parent ?? tmpdir()),
  },
  {
    name: "reset-leaves-state",
    mutation: "initialize() keeps prior state, so the second trace starts from the first trace's result.",
    expect: { traceIndex: 2, stateIndex: 0, action: "init", code: "step_mismatch" },
    create: (parent) => ResetLeavesStateQueue.create(parent ?? tmpdir()),
  },
];

export interface AcceptanceScenarioResult {
  readonly fault: string;
  readonly mutation: string;
  readonly accepted: boolean;
  readonly firstMismatch: ReplayFailure | null;
  readonly traceIndex: number | null;
  readonly statesMatched: number;
  readonly stepsCompleted: number;
  readonly durationMs: number;
}

export interface AcceptanceRunOptions {
  readonly root?: string;
  readonly mirrorBinary?: string;
  readonly modelPath?: string;
  readonly tracePath?: string;
  readonly actionTimeoutMs?: number;
  readonly receiveTimeoutMs?: number;
}

export interface AcceptanceReceipt {
  readonly schema: "mirrorecma.work-queue-acceptance/v1";
  readonly generatedAt: string;
  readonly model: { readonly path: string; readonly sha256: string };
  readonly witness: { readonly path: string; readonly sha256: string };
  readonly mirrorBinary: string;
  readonly mirrorSha256: string;
  readonly implementationSha256: string;
  readonly correctReport: ReplayReport;
  readonly controls: readonly { readonly variant: string; readonly code: string }[];
  readonly node: string;
  readonly faults: readonly {
    readonly name: string;
    readonly mutation: string;
    readonly expect: FirstMismatchExpectation;
    readonly observed: ReplayFailure | null;
    readonly rejected: boolean;
    readonly statesMatched: number;
    readonly stepsCompleted: number;
    readonly durationMs: number;
  }[];
  readonly cleanup: { readonly storeParent: string; readonly remainingEntries: readonly string[] };
}

export interface AcceptanceRunResult {
  readonly scenarios: readonly AcceptanceScenarioResult[];
  readonly correctReport: ReplayReport;
  readonly receipt: AcceptanceReceipt;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function failureOf(error: unknown): ReplayFailure | null {
  const report = replayReportFromError(error);
  return report?.failure ?? null;
}

function fallbackReport(startedAt: number): ReplayReport {
  return {
    schema: "mirrorecma.replay-report/v1", status: "failed", durationMs: Date.now() - startedAt,
    tracesStarted: 0, tracesCompleted: 0, statesReported: 0, statesMatched: 0, stepsCompleted: 0,
    actionCounts: {}, sequenceCounts: [],
    coverage: { actionLimit: 0, sequenceLimit: 0, droppedActionEvents: 0, droppedSequenceEvents: 0, truncated: false },
  };
}

function matchesExpectation(failure: ReplayFailure | null, expect: FirstMismatchExpectation): boolean {
  return failure !== null && failure.traceIndex === expect.traceIndex && failure.stateIndex === expect.stateIndex
    && failure.action === expect.action && failure.code === expect.code;
}

/**
 * Runs the checked WorkQueue witness against the correct implementation and
 * every seeded fault through the same negotiated runner, adapter, and
 * observers. A fault is accepted only when the deterministic witness rejects
 * it at the pinned first mismatch, so a change that hides the fault or the
 * harness misclassifying an action error fails the acceptance run.
 */
export async function runQueueAcceptance(options: AcceptanceRunOptions = {}): Promise<AcceptanceRunResult> {
  const root = resolve(options.root ?? process.cwd());
  const model = resolve(options.modelPath ?? join(root, "examples/work-queue/specs/WorkQueue.tla"));
  const trace = resolve(options.tracePath ?? join(root, "examples/work-queue/artifacts/witness.itf.json"));
  const mirror = resolve(options.mirrorBinary ?? join(root, "../Mirrors/.lake/build/bin/mirror"));
  const config: ApalacheConfig = {
    specPath: model, initPredicate: "Init", nextPredicate: "WitnessNext",
    invariant: "TraceComplete", lengthBound: 15, paramVars: "parameters",
  };
  const replayOptions = {
    actionTimeoutMs: options.actionTimeoutMs ?? 10_000,
    receiveTimeoutMs: options.receiveTimeoutMs ?? 30_000,
  };
  const storeParent = await mkdtemp(join(tmpdir(), "queue-acceptance-"));
  try {
    let correctReport: ReplayReport;
    try {
      correctReport = await runClientWithTracesNegotiatedWithReport(mirror, config, [trace, trace],
        createQueueSelection(() => WorkQueue.create(storeParent)), replayOptions);
      assertQueueCoverage(correctReport);
    } catch (error) {
      throw new Error(`the correct implementation was rejected by the witness: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (correctReport.status !== "passed") throw new Error("the correct implementation did not produce a passing report");

    const scenarios: AcceptanceScenarioResult[] = [];
    const statedFaults = seededFaults;
    for (const fault of statedFaults) {
      const startedAt = Date.now();
      let report: ReplayReport;
      let failure: ReplayFailure | null = null;
      try {
        report = await runClientWithTracesNegotiatedWithReport(mirror, config, [trace, trace],
          createQueueSelection(() => fault.create(storeParent)), replayOptions);
      } catch (error) {
        failure = failureOf(error);
        report = replayReportFromError(error) ?? fallbackReport(startedAt);
      }
      const accepted = matchesExpectation(failure, fault.expect);
      scenarios.push({
        fault: fault.name, mutation: fault.mutation, accepted,
        firstMismatch: failure, traceIndex: failure?.traceIndex ?? null,
        statesMatched: report.statesMatched, stepsCompleted: report.stepsCompleted, durationMs: report.durationMs,
      });
      if ((await readdir(storeParent)).length !== 0) throw new Error(`${fault.name}: leaked application store`);
    }
    const controls: { variant: string; code: string }[] = [];
    for (const variant of ["crash", "hang", "cancel"] as const) {
      const controller = new AbortController();
      let failure: ReplayFailure | null = null;
      try {
        await runClientWithTracesNegotiatedWithReport(mirror, config, [trace], createQueueSelection(async () => {
          const queue = await WorkQueue.create(storeParent);
          queue.enqueue = async (_item, signal) => {
            if (variant === "crash") throw new Error("injected application failure");
            if (variant === "cancel") controller.abort("acceptance cancellation");
            return new Promise<void>((_resolve, reject) => {
              if (signal?.aborted) reject(signal.reason);
              else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          };
          return queue;
        }), { ...replayOptions, signal: controller.signal, actionTimeoutMs: variant === "hang" ? 100 : 10_000 });
      } catch (error) { failure = failureOf(error); }
      const expected = { crash: "adapter_failure", hang: "action_timeout", cancel: "replay_aborted" }[variant];
      if (failure?.code !== expected) throw new Error(`${variant}: expected ${expected}, got ${failure?.code}`);
      if ((await readdir(storeParent)).length !== 0) throw new Error(`${variant}: leaked application store`);
      controls.push({ variant, code: failure.code });
    }
    const remainingEntries = (await readdir(storeParent)).sort();
    if (remainingEntries.length !== 0) throw new Error("WorkQueue acceptance leaked its store");
    const receipt: AcceptanceReceipt = {
      schema: "mirrorecma.work-queue-acceptance/v1",
      generatedAt: new Date().toISOString(),
      model: { path: model, sha256: await digest(model) },
      witness: { path: trace, sha256: await digest(trace) },
      mirrorBinary: mirror,
      mirrorSha256: await digest(mirror),
      implementationSha256: await digest(join(root, "examples/work-queue/queue.ts")),
      correctReport,
      controls,
      node: process.version,
      faults: scenarios.map((scenario, index) => ({
        name: scenario.fault, mutation: scenario.mutation, expect: statedFaults[index]!.expect,
        observed: scenario.firstMismatch, rejected: scenario.accepted,
        statesMatched: scenario.statesMatched, stepsCompleted: scenario.stepsCompleted, durationMs: scenario.durationMs,
      })),
      cleanup: { storeParent, remainingEntries },
    };
    return { scenarios, correctReport, receipt };
  } finally {
    await rm(storeParent, { recursive: true, force: true });
  }
}
