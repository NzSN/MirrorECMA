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
import type { ReproductionStabilityRecord } from "./reproduction-stability.js";

export interface PrefixReductionPolicy {
  readonly candidateLimit: number;
  readonly totalBudgetMs: number;
  readonly perCandidateBudgetMs: number;
  readonly cleanupBudgetMs: number;
}
export interface PrefixCandidateResult {
  readonly order: number;
  readonly prefixLength: number;
  readonly validity: "valid" | "invalid";
  readonly outcome:
    | "reproduced"
    | "not_reproduced"
    | "timed_out"
    | "cancelled"
    | "failed"
    | "cleanup_unconfirmed"
    | "not_run";
  readonly code?: string;
  readonly durationMs: number;
}
export interface PrefixReductionResult {
  readonly schema: "mirrorecma.reproduction-prefix-reduction/v1";
  readonly originalRunId: string;
  readonly originalBundleSha256: string;
  readonly traceIndex: number;
  readonly originalLength: number;
  readonly bestPrefixLength: number | null;
  readonly claim:
    | "shortest_reproducing_prefix"
    | "smallest_observed_reproducing_prefix"
    | "not_reduced";
  readonly minimalityComplete: boolean;
  readonly stopReason:
    | "complete"
    | "candidate_limit"
    | "total_budget"
    | "cancelled"
    | "cleanup_independence_lost"
    | "candidate_failure"
    | "not_eligible";
  readonly candidates: readonly PrefixCandidateResult[];
}
export interface ReduceReproductionPrefixOptions<T> {
  readonly traceIndex: number;
  readonly steps: readonly T[];
  readonly stability: ReproductionStabilityRecord;
  readonly resettable: boolean;
  readonly policy: PrefixReductionPolicy;
  readonly signal?: AbortSignal;
  readonly validateCandidate: (
    prefix: readonly T[],
    signal: AbortSignal,
  ) => Promise<{ readonly valid: boolean; readonly code?: string }>;
  readonly evaluateCandidate: (
    prefix: readonly T[],
    signal: AbortSignal,
  ) => Promise<ReproductionReplayResult>;
}
function policy(value: PrefixReductionPolicy): PrefixReductionPolicy {
  if (
    !Number.isSafeInteger(value.candidateLimit) ||
    value.candidateLimit < 1 ||
    value.candidateLimit > 4096 ||
    !Number.isSafeInteger(value.totalBudgetMs) ||
    value.totalBudgetMs < 1 ||
    value.totalBudgetMs > 0x7fffffff ||
    !Number.isSafeInteger(value.perCandidateBudgetMs) ||
    value.perCandidateBudgetMs < 1 ||
    value.perCandidateBudgetMs > 0x7fffffff ||
    !Number.isSafeInteger(value.cleanupBudgetMs) ||
    value.cleanupBudgetMs < 1 ||
    value.cleanupBudgetMs > 0x7fffffff
  )
    throw new TypeError("invalid reduction policy");
  return Object.freeze({ ...value });
}
async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  budget: number,
  parent?: AbortSignal,
): Promise<{
  boundary: { kind: "result"; value: T } | { kind: "timed_out" | "cancelled" };
  pending?: Promise<T>;
}> {
  if (parent?.aborted) return { boundary: { kind: "cancelled" } };
  const controller = new AbortController(),
    forward = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined,
    abort = () => {};
  const pending = Promise.resolve().then(() => {
    if (controller.signal.aborted)
      throw new Error("candidate cancelled before start");
    return run(controller.signal);
  });
  void pending.catch(() => {});
  const boundary = new Promise<{ kind: "timed_out" | "cancelled" }>(
    (resolve) => {
      timer = setTimeout(() => {
        controller.abort("candidate timeout");
        resolve({ kind: "timed_out" });
      }, budget);
      abort = () => {
        controller.abort(parent?.reason);
        resolve({ kind: "cancelled" });
      };
      parent?.addEventListener("abort", abort, { once: true });
    },
  );
  try {
    const result = await Promise.race([
      pending.then((value) => ({ kind: "result" as const, value })),
      boundary,
    ]);
    return { boundary: result, pending };
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", forward);
    parent?.removeEventListener("abort", abort);
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
export async function reduceReproductionPrefix<T>(
  bundle: ReproductionBundle,
  options: ReduceReproductionPrefixOptions<T>,
): Promise<PrefixReductionResult> {
  const p = policy(options.policy),
    originalLength = options.steps.length,
    candidates: PrefixCandidateResult[] = [],
    originalBundleSha256 = reproductionBundleSha256(bundle);
  const finish = (
    bestPrefixLength: number | null,
    claim: PrefixReductionResult["claim"],
    minimalityComplete: boolean,
    stopReason: PrefixReductionResult["stopReason"],
  ): PrefixReductionResult =>
    Object.freeze({
      schema: "mirrorecma.reproduction-prefix-reduction/v1",
      originalRunId: bundle.evidenceLinks.runRef.runId,
      originalBundleSha256,
      traceIndex: options.traceIndex,
      originalLength,
      bestPrefixLength,
      claim,
      minimalityComplete,
      stopReason,
      candidates: Object.freeze(candidates),
    });
  if (
    !options.resettable ||
    bundle.signature.primary?.kind !== "behavioral_mismatch" ||
    bundle.signature.cleanup.status !== "succeeded" ||
    options.stability.classification !== "stable" ||
    options.stability.independence !== "confirmed" ||
    options.stability.runId !== bundle.evidenceLinks.runRef.runId ||
    options.stability.bundleSha256 !== originalBundleSha256 ||
    bundle.signature.primary.traceIndex !== options.traceIndex ||
    !originalLength
  )
    return finish(null, "not_reduced", false, "not_eligible");
  const began = performance.now();
  let best: number | null = null,
    complete = true;
  for (let length = originalLength; length >= 1; length--) {
    if (options.signal?.aborted)
      return finish(
        best,
        best === null ? "not_reduced" : "smallest_observed_reproducing_prefix",
        false,
        "cancelled",
      );
    if (candidates.length >= p.candidateLimit)
      return finish(
        best,
        best === null ? "not_reduced" : "smallest_observed_reproducing_prefix",
        false,
        "candidate_limit",
      );
    const remaining = p.totalBudgetMs - (performance.now() - began);
    if (remaining <= 0)
      return finish(
        best,
        best === null ? "not_reduced" : "smallest_observed_reproducing_prefix",
        false,
        "total_budget",
      );
    const prefix = Object.freeze(options.steps.slice(0, length)),
      started = performance.now(),
      budget = Math.max(
        1,
        Math.min(p.perCandidateBudgetMs, Math.floor(remaining)),
      ),
      order = candidates.length + 1;
    try {
      const validation = await bounded(
        (signal) => options.validateCandidate(prefix, signal),
        budget,
        options.signal,
      );
      if (validation.boundary.kind !== "result") {
        candidates.push(
          Object.freeze({
            order,
            prefixLength: length,
            validity: "valid",
            outcome: validation.boundary.kind,
            durationMs: performance.now() - started,
          }),
        );
        return finish(
          best,
          best === null
            ? "not_reduced"
            : "smallest_observed_reproducing_prefix",
          false,
          validation.boundary.kind === "cancelled"
            ? "cancelled"
            : "candidate_failure",
        );
      }
      if (!validation.boundary.value.valid) {
        candidates.push(
          Object.freeze({
            order,
            prefixLength: length,
            validity: "invalid",
            outcome: "not_run",
            durationMs: performance.now() - started,
            ...(validation.boundary.value.code
              ? { code: validation.boundary.value.code }
              : {}),
          }),
        );
        continue;
      }
      if (options.signal?.aborted)
        return finish(
          best,
          best === null
            ? "not_reduced"
            : "smallest_observed_reproducing_prefix",
          false,
          "cancelled",
        );
      const elapsed = performance.now() - started;
      const evaluation = await bounded(
        (signal) => options.evaluateCandidate(prefix, signal),
        Math.max(1, budget - Math.floor(elapsed)),
        options.signal,
      );
      if (evaluation.boundary.kind !== "result") {
        const settled = await awaitCleanupSettlement(
          evaluation.pending,
          p.cleanupBudgetMs,
        );
        const cleanup = settled?.suiteResult?.cleanup.status ?? "unconfirmed";
        candidates.push(
          Object.freeze({
            order,
            prefixLength: length,
            validity: "valid",
            outcome:
              cleanup === "succeeded"
                ? evaluation.boundary.kind
                : "cleanup_unconfirmed",
            durationMs: performance.now() - started,
          }),
        );
        return finish(
          best,
          best === null
            ? "not_reduced"
            : "smallest_observed_reproducing_prefix",
          false,
          cleanup !== "succeeded"
            ? "cleanup_independence_lost"
            : evaluation.boundary.kind === "cancelled"
              ? "cancelled"
              : "candidate_failure",
        );
      }
      const replay = evaluation.boundary.value,
        cleanup =
          replay.suiteResult?.cleanup.status ??
          replay.observed?.cleanup.status ??
          "unconfirmed";
      if (
        !signaturesEqual(bundle.signature, replay.expected) ||
        (replay.status === "reproduced" &&
          !replayResultMatchesBundle(bundle, replay))
      ) {
        candidates.push(
          Object.freeze({
            order,
            prefixLength: length,
            validity: "valid" as const,
            outcome: "failed" as const,
            code: "stale_replay_result",
            durationMs: performance.now() - started,
          }),
        );
        return finish(
          best,
          best === null
            ? "not_reduced"
            : "smallest_observed_reproducing_prefix",
          false,
          "candidate_failure",
        );
      }
      if (cleanup !== "succeeded") {
        candidates.push(
          Object.freeze({
            order,
            prefixLength: length,
            validity: "valid",
            outcome: "cleanup_unconfirmed",
            durationMs: performance.now() - started,
          }),
        );
        return finish(
          best,
          best === null
            ? "not_reduced"
            : "smallest_observed_reproducing_prefix",
          false,
          "cleanup_independence_lost",
        );
      }
      candidates.push(
        Object.freeze({
          order,
          prefixLength: length,
          validity: "valid",
          outcome: replay.status,
          durationMs: performance.now() - started,
        }),
      );
      if (replay.status === "reproduced") best = length;
    } catch {
      complete = false;
      candidates.push(
        Object.freeze({
          order,
          prefixLength: length,
          validity: "valid",
          outcome: "failed",
          durationMs: performance.now() - started,
        }),
      );
      return finish(
        best,
        best === null ? "not_reduced" : "smallest_observed_reproducing_prefix",
        false,
        "candidate_failure",
      );
    }
  }
  const invalidShorter =
    best !== null &&
    candidates.some(
      (candidate) =>
        candidate.validity === "invalid" && candidate.prefixLength < best,
    );
  return finish(
    best,
    best === null
      ? "not_reduced"
      : invalidShorter
        ? "smallest_observed_reproducing_prefix"
        : "shortest_reproducing_prefix",
    complete && !invalidShorter,
    "complete",
  );
}
