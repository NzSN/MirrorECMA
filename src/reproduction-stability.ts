import { performance } from "node:perf_hooks";
import type {
  ReproductionBundle,
  ReproductionReplayResult,
} from "./reproduction-bundle.js";
import {
  replayResultMatchesBundle,
  reproductionBundleSha256,
  signaturesEqual,
} from "./reproduction-bundle.js";

export interface ReproductionStabilityPolicy {
  readonly attemptLimit: number;
  readonly totalBudgetMs: number;
  readonly perAttemptBudgetMs: number;
  readonly cleanupBudgetMs: number;
}
export type StabilityAttemptOutcome =
  | "reproduced"
  | "not_reproduced"
  | "timed_out"
  | "cancelled"
  | "refused"
  | "failed"
  | "cleanup_unconfirmed";
export interface StabilityAttempt {
  readonly attempt: number;
  readonly outcome: StabilityAttemptOutcome;
  readonly cleanup: "succeeded" | "failed" | "unconfirmed" | "unknown";
  readonly durationMs: number;
  readonly code?: string;
  readonly replay?: ReproductionReplayResult;
}
export interface ReproductionStabilityRecord {
  readonly schema: "mirrorecma.reproduction-stability/v1";
  readonly runId: string;
  readonly bundleSha256: string;
  readonly policy: ReproductionStabilityPolicy;
  readonly resettable: boolean;
  readonly classification:
    | "stable"
    | "not_reproduced"
    | "unstable"
    | "inconclusive"
    | "cancelled";
  readonly attempts: readonly StabilityAttempt[];
  readonly independence: "confirmed" | "lost" | "not_established";
  readonly reasonCode?: string;
}
export interface ClassifyReproductionStabilityOptions {
  readonly policy: ReproductionStabilityPolicy;
  readonly resettable: boolean;
  readonly signal?: AbortSignal;
  readonly attempt: (
    attempt: number,
    signal: AbortSignal,
  ) => Promise<ReproductionReplayResult>;
}

function validatePolicy(
  policy: ReproductionStabilityPolicy,
): ReproductionStabilityPolicy {
  if (
    !Number.isSafeInteger(policy.attemptLimit) ||
    policy.attemptLimit < 1 ||
    policy.attemptLimit > 100 ||
    !Number.isSafeInteger(policy.totalBudgetMs) ||
    policy.totalBudgetMs < 1 ||
    policy.totalBudgetMs > 0x7fffffff ||
    !Number.isSafeInteger(policy.perAttemptBudgetMs) ||
    policy.perAttemptBudgetMs < 1 ||
    policy.perAttemptBudgetMs > 0x7fffffff ||
    !Number.isSafeInteger(policy.cleanupBudgetMs) ||
    policy.cleanupBudgetMs < 1 ||
    policy.cleanupBudgetMs > 0x7fffffff
  )
    throw new TypeError("invalid stability policy");
  return Object.freeze({ ...policy });
}
function safeCode(error: unknown): string | undefined {
  try {
    if (!error || typeof error !== "object") return;
    const d = Object.getOwnPropertyDescriptor(error, "code");
    return d && "value" in d && typeof d.value === "string"
      ? d.value
      : undefined;
  } catch {
    return;
  }
}
async function boundedAttempt(
  run: () => Promise<ReproductionReplayResult>,
  budgetMs: number,
  signal: AbortSignal,
): Promise<{
  boundary:
    | { kind: "result"; value: ReproductionReplayResult }
    | { kind: "timed_out" | "cancelled" };
  pending?: Promise<ReproductionReplayResult>;
}> {
  if (signal.aborted) return { boundary: { kind: "cancelled" } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const pending = Promise.resolve().then(() => {
    if (signal.aborted) throw new Error("attempt cancelled before start");
    return run();
  });
  void pending.catch(() => {});
  const boundary = new Promise<{ kind: "timed_out" | "cancelled" }>(
    (resolve) => {
      timer = setTimeout(() => resolve({ kind: "timed_out" }), budgetMs);
      abort = () => resolve({ kind: "cancelled" });
      signal.addEventListener("abort", abort, { once: true });
    },
  );
  try {
    const resolved = await Promise.race([
      pending.then((value) => ({ kind: "result" as const, value })),
      boundary,
    ]);
    return { boundary: resolved, pending };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function awaitCleanupSettlement(
  pending: Promise<ReproductionReplayResult> | undefined,
  budgetMs: number,
): Promise<ReproductionReplayResult | undefined> {
  if (!pending) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function classifyReproductionStability(
  bundle: ReproductionBundle,
  options: ClassifyReproductionStabilityOptions,
): Promise<ReproductionStabilityRecord> {
  const policy = validatePolicy(options.policy),
    attempts: StabilityAttempt[] = [],
    bundleSha256 = reproductionBundleSha256(bundle);
  if (!options.resettable)
    return Object.freeze({
      schema: "mirrorecma.reproduction-stability/v1",
      runId: bundle.evidenceLinks.runRef.runId,
      bundleSha256,
      policy,
      resettable: false,
      classification: "inconclusive",
      attempts: Object.freeze([]),
      independence: "not_established",
      reasonCode: "not_resettable",
    });
  const began = performance.now();
  let independence: "confirmed" | "lost" = "confirmed";
  let reasonCode: string | undefined;
  for (let attempt = 1; attempt <= policy.attemptLimit; attempt++) {
    if (options.signal?.aborted) {
      reasonCode = "caller_cancelled";
      return Object.freeze({
        schema: "mirrorecma.reproduction-stability/v1",
        runId: bundle.evidenceLinks.runRef.runId,
        bundleSha256,
        policy,
        resettable: true,
        classification: "cancelled",
        attempts: Object.freeze(attempts),
        independence,
        reasonCode,
      });
    }
    const remaining = policy.totalBudgetMs - (performance.now() - began);
    if (remaining <= 0) {
      reasonCode = "total_budget_exhausted";
      break;
    }
    const controller = new AbortController(),
      forward = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forward, { once: true });
    const started = performance.now();
    try {
      const bounded = await boundedAttempt(
        () => options.attempt(attempt, controller.signal),
        Math.max(1, Math.min(policy.perAttemptBudgetMs, Math.floor(remaining))),
        controller.signal,
      );
      if (bounded.boundary.kind !== "result") {
        controller.abort(bounded.boundary.kind);
        const settled = await awaitCleanupSettlement(
          bounded.pending,
          policy.cleanupBudgetMs,
        );
        const cleanup = settled?.suiteResult?.cleanup.status ?? "unconfirmed";
        attempts.push(
          Object.freeze({
            attempt,
            outcome: bounded.boundary.kind,
            cleanup,
            durationMs: performance.now() - started,
          }),
        );
        if (cleanup !== "succeeded") independence = "lost";
        reasonCode = bounded.boundary.kind;
        break;
      }
      const replay = bounded.boundary.value,
        cleanup =
          replay.suiteResult?.cleanup.status ??
          replay.observed?.cleanup.status ??
          "unknown";
      if (
        !signaturesEqual(bundle.signature, replay.expected) ||
        (replay.status === "reproduced" &&
          !replayResultMatchesBundle(bundle, replay))
      ) {
        attempts.push(
          Object.freeze({
            attempt,
            outcome: "failed" as const,
            cleanup,
            code: "stale_replay_result",
            durationMs: performance.now() - started,
            replay,
          }),
        );
        if (cleanup !== "succeeded") independence = "lost";
        reasonCode = "stale_replay_result";
        break;
      }
      const outcome: StabilityAttemptOutcome =
        cleanup !== "succeeded" ? "cleanup_unconfirmed" : replay.status;
      attempts.push(
        Object.freeze({
          attempt,
          outcome,
          cleanup,
          durationMs: performance.now() - started,
          replay,
        }),
      );
      if (cleanup !== "succeeded") {
        independence = "lost";
        reasonCode = "cleanup_independence_lost";
        break;
      }
    } catch (error) {
      independence = "lost";
      attempts.push(
        Object.freeze({
          attempt,
          outcome: safeCode(error)?.includes("refus") ? "refused" : "failed",
          cleanup: "unknown",
          durationMs: performance.now() - started,
          ...(safeCode(error) ? { code: safeCode(error) } : {}),
        }),
      );
      reasonCode = "attempt_failed";
      break;
    } finally {
      options.signal?.removeEventListener("abort", forward);
    }
  }
  let classification: ReproductionStabilityRecord["classification"];
  if (options.signal?.aborted) classification = "cancelled";
  else if (
    independence === "lost" ||
    attempts.some(
      (a) => !["reproduced", "not_reproduced"].includes(a.outcome),
    ) ||
    attempts.length < policy.attemptLimit
  )
    classification = "inconclusive";
  else {
    const reproduced = attempts.filter(
      (a) => a.outcome === "reproduced",
    ).length;
    classification =
      reproduced === attempts.length
        ? "stable"
        : reproduced === 0
          ? "not_reproduced"
          : "unstable";
  }
  return Object.freeze({
    schema: "mirrorecma.reproduction-stability/v1",
    runId: bundle.evidenceLinks.runRef.runId,
    bundleSha256,
    policy,
    resettable: true,
    classification,
    attempts: Object.freeze(attempts),
    independence,
    ...(reasonCode ? { reasonCode } : {}),
  });
}
