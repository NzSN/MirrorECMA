import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  replayResultMatchesBundle,
  reproductionBundleSha256,
  type ReproductionBundle,
  type ReproductionReplayResult,
} from "./reproduction-bundle.js";
import { preflightSuite, type SuitePreflight } from "./suite-preflight.js";
import type { SuiteDefinition } from "./suite-definition.js";
import type { ReproductionStabilityRecord } from "./reproduction-stability.js";

export const LEASE_REDUCTION_SCHEMA =
  "mirrors.reduction-candidate/lease-service-input-shrink/v1" as const;
export const LEASE_REDUCTION_PROFILE = "lease-service-input-shrink/v1" as const;
export const LEASE_REDUCTION_DOMAIN_VERSION = "LeaseService.Next/v1" as const;
const SHA256 = /^[a-f0-9]{64}$/;

export interface LeaseReductionEdit {
  readonly stateIndex: number;
  readonly actionId: "Acquire" | "Renew" | "Release" | "Write";
  readonly inputId: "Client" | "Token";
  readonly before: 2;
  readonly after: 1;
}
export interface LeaseReductionCandidate {
  readonly schema: typeof LEASE_REDUCTION_SCHEMA;
  readonly modelSha256: string;
  readonly interfaceDigest: string;
  readonly orderedCorpusSha256: string;
  readonly originalBundleSha256: string;
  readonly selectedTraceSha256: string;
  readonly traceIndex: 0;
  readonly traceOccurrences: readonly [0, 1];
  readonly edits: readonly LeaseReductionEdit[];
}
export interface LeaseReductionAuthority {
  readonly profile: typeof LEASE_REDUCTION_PROFILE;
  readonly domainVersion: typeof LEASE_REDUCTION_DOMAIN_VERSION;
  readonly validator: { readonly id: string; readonly sha256: string };
  readonly apalache: { readonly version: "0.61.0"; readonly sha256: string };
  readonly java: {
    readonly observedVersion: string;
    readonly selectedVersion: "25.0.4+7";
    readonly executableSha256: string;
    readonly archiveSha256: string;
    readonly distributionQualified: boolean;
    readonly qualificationRef: string;
  };
}
export interface LeaseOracleReceipt {
  readonly schema: "mirrorecma.lease-reduction-oracle/v1";
  readonly status: "model_valid";
  readonly profile: typeof LEASE_REDUCTION_PROFILE;
  readonly domainVersion: typeof LEASE_REDUCTION_DOMAIN_VERSION;
  readonly modelSha256: string;
  readonly interfaceDigest: string;
  readonly originalCorpusSha256: string;
  readonly candidateCorpusSha256: string;
  readonly selectedTraceSha256: string;
  readonly traceOccurrences: readonly [0, 1];
  readonly validator: LeaseReductionAuthority["validator"];
  readonly apalache: LeaseReductionAuthority["apalache"];
  readonly java: LeaseReductionAuthority["java"];
}
export interface MaterializedLeaseCandidate<Port> {
  readonly suite: SuiteDefinition<Port>;
  readonly receipt: LeaseOracleReceipt;
}
export interface LeaseReductionPolicy {
  readonly totalBudgetMs: number;
  readonly oracleBudgetMs: number;
  readonly evaluationBudgetMs: number;
  readonly cleanupBudgetMs: number;
}
export interface LeaseReductionOptions<Port> {
  readonly applicationId: string;
  readonly candidate: LeaseReductionCandidate;
  readonly authority: LeaseReductionAuthority;
  readonly stability: ReproductionStabilityRecord;
  readonly resettable: boolean;
  readonly policy: LeaseReductionPolicy;
  readonly signal?: AbortSignal;
  readonly materialize: (
    candidate: LeaseReductionCandidate,
    signal: AbortSignal,
  ) => Promise<MaterializedLeaseCandidate<Port>>;
  readonly evaluate: (
    suite: SuiteDefinition<Port>,
    signal: AbortSignal,
  ) => Promise<ReproductionReplayResult>;
}
export interface LeaseReductionResult {
  readonly schema: "mirrorecma.lease-input-reduction-result/v1";
  readonly status:
    | "reduced"
    | "not_reproduced"
    | "inconclusive"
    | "cancelled"
    | "reduction_profile_unsupported";
  readonly originalBundleSha256: string;
  readonly candidate?: LeaseReductionCandidate;
  readonly oracle?: LeaseOracleReceipt;
  readonly preflight?: {
    readonly modelDigest: string;
    readonly corpusDigest: string;
  };
  readonly replay?: ReproductionReplayResult;
  readonly reasonCode?: string;
  readonly globalMinimumClaim: false;
}

export class LeaseReductionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LeaseReductionError";
  }
}
function validatePolicy(policy: LeaseReductionPolicy): LeaseReductionPolicy {
  for (const value of Object.values(policy))
    if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff)
      throw new LeaseReductionError(
        "reduction_policy_invalid",
        "reduction budgets must be positive bounded integers",
      );
  return Object.freeze({ ...policy });
}
function supportedEdit(edit: LeaseReductionEdit): boolean {
  if (
    !Number.isSafeInteger(edit.stateIndex) ||
    edit.stateIndex < 1 ||
    edit.before !== 2 ||
    edit.after !== 1
  )
    return false;
  if (edit.actionId === "Acquire") return edit.inputId === "Client";
  return (
    ["Renew", "Release", "Write"].includes(edit.actionId) &&
    ["Client", "Token"].includes(edit.inputId)
  );
}
export function validateLeaseReductionCandidate(
  candidate: LeaseReductionCandidate,
): LeaseReductionCandidate {
  if (candidate.schema !== LEASE_REDUCTION_SCHEMA)
    throw new LeaseReductionError(
      "reduction_schema_unsupported",
      "unsupported LeaseService reduction schema",
    );
  for (const digest of [
    candidate.modelSha256,
    candidate.interfaceDigest,
    candidate.orderedCorpusSha256,
    candidate.originalBundleSha256,
    candidate.selectedTraceSha256,
  ])
    if (!SHA256.test(digest))
      throw new LeaseReductionError(
        "reduction_identity_invalid",
        "candidate identities must be lowercase SHA-256",
      );
  if (candidate.traceIndex !== 0)
    throw new LeaseReductionError(
      "reduction_trace_unsupported",
      "version 1 supports selected trace zero",
    );
  if (
    !Array.isArray(candidate.traceOccurrences) ||
    candidate.traceOccurrences.length !== 2 ||
    candidate.traceOccurrences[0] !== 0 ||
    candidate.traceOccurrences[1] !== 1
  )
    throw new LeaseReductionError(
      "reduction_trace_unsupported",
      "version 1 requires the selected trace at ordered occurrences zero and one",
    );
  if (
    !Array.isArray(candidate.edits) ||
    candidate.edits.length < 1 ||
    candidate.edits.length > 16 ||
    candidate.edits.some((edit) => !supportedEdit(edit))
  )
    throw new LeaseReductionError(
      "reduction_transform_unsupported",
      "candidate contains an unsupported input transform",
    );
  const keys = candidate.edits.map(
    (edit) => `${edit.stateIndex}:${edit.actionId}:${edit.inputId}`,
  );
  if (new Set(keys).size !== keys.length)
    throw new LeaseReductionError(
      "reduction_edit_duplicate",
      "candidate contains duplicate edits",
    );
  return Object.freeze({
    ...candidate,
    edits: Object.freeze(
      candidate.edits.map((edit) => Object.freeze({ ...edit })),
    ),
  });
}
function validateAuthority(authority: LeaseReductionAuthority): void {
  if (
    authority.profile !== LEASE_REDUCTION_PROFILE ||
    authority.domainVersion !== LEASE_REDUCTION_DOMAIN_VERSION ||
    !authority.validator.id ||
    !SHA256.test(authority.validator.sha256) ||
    authority.apalache.version !== "0.61.0" ||
    !SHA256.test(authority.apalache.sha256) ||
    !authority.java.observedVersion ||
    authority.java.selectedVersion !== "25.0.4+7" ||
    !SHA256.test(authority.java.executableSha256) ||
    !SHA256.test(authority.java.archiveSha256) ||
    !authority.java.qualificationRef ||
    (authority.java.distributionQualified &&
      !authority.java.qualificationRef.includes(authority.java.archiveSha256))
  )
    throw new LeaseReductionError(
      "reduction_authority_invalid",
      "evaluator reduction authority is invalid",
    );
}
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  budgetMs: number,
  parent?: AbortSignal,
): Promise<
  | { status: "completed"; value: T; pending: Promise<T> }
  | { status: "timed_out" | "cancelled"; pending?: Promise<T> }
> {
  if (parent?.aborted) return { status: "cancelled" };
  const controller = new AbortController();
  const forward = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const pending = Promise.resolve().then(() => {
    if (controller.signal.aborted)
      throw new LeaseReductionError(
        "reduction_cancelled",
        "cancelled before start",
      );
    return operation(controller.signal);
  });
  void pending.catch(() => {});
  const boundary = new Promise<"timed_out" | "cancelled">((resolve) => {
    timer = setTimeout(() => {
      controller.abort("reduction timeout");
      resolve("timed_out");
    }, budgetMs);
    abort = () => {
      controller.abort(parent?.reason);
      resolve("cancelled");
    };
    parent?.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([
      pending.then((value) => ({ completed: true as const, value })),
      boundary.then((status) => ({ completed: false as const, status })),
    ]);
    return result.completed
      ? { status: "completed", value: result.value, pending }
      : { status: result.status, pending };
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", forward);
    parent?.removeEventListener("abort", abort);
  }
}
async function awaitReplayCleanup(
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
function rawBigint(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 &&
    typeof record["#bigint"] === "string"
    ? record["#bigint"]
    : undefined;
}

function differences(left: unknown, right: unknown, path = ""): string[] {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return [path];
    return left.flatMap((item, index) =>
      differences(item, right[index], `${path}/${index}`),
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    return keys.flatMap((key) =>
      differences(leftRecord[key], rightRecord[key], `${path}/${key}`),
    );
  }
  return [path];
}

/**
 * Applies only the declared LeaseService v1 edits and proves that no action,
 * metadata, state value, or undeclared input changed. Model validity remains a
 * separate original Init/Next oracle obligation.
 */
export function materializeLeaseReductionTrace(
  original: unknown,
  candidateInput: LeaseReductionCandidate,
): { readonly trace: unknown; readonly changedPaths: readonly string[] } {
  const candidate = validateLeaseReductionCandidate(candidateInput);
  if (
    !original ||
    typeof original !== "object" ||
    Array.isArray(original) ||
    !Array.isArray((original as { states?: unknown }).states)
  )
    throw new LeaseReductionError(
      "reduction_candidate_invalid",
      "original trace has no states",
    );
  const trace = structuredClone(original) as { states: Record<string, unknown>[] };
  const source = original as { states: Record<string, unknown>[] };
  const allowed = new Set<string>();
  const wireAction: Record<LeaseReductionEdit["actionId"], string> = {
    Acquire: "acquire",
    Renew: "renew",
    Release: "release",
    Write: "write",
  };
  for (const edit of candidate.edits) {
    const before = source.states[edit.stateIndex];
    const after = trace.states[edit.stateIndex];
    if (!before || !after || before.action_taken !== wireAction[edit.actionId])
      throw new LeaseReductionError(
        "reduction_candidate_invalid",
        "declared edit action does not match the original trace",
      );
    const input = edit.inputId === "Client" ? "client" : "token";
    const beforeParameters = before.parameters;
    const afterParameters = after.parameters;
    if (
      !beforeParameters ||
      !afterParameters ||
      typeof beforeParameters !== "object" ||
      typeof afterParameters !== "object" ||
      rawBigint((beforeParameters as Record<string, unknown>)[input]) !==
        String(edit.before)
    )
      throw new LeaseReductionError(
        "reduction_candidate_invalid",
        "declared before value does not match the original trace",
      );
    (afterParameters as Record<string, unknown>)[input] = {
      "#bigint": String(edit.after),
    };
    allowed.add(`/states/${edit.stateIndex}/parameters/${input}/#bigint`);
  }
  const changedPaths = differences(original, trace).sort();
  if (
    changedPaths.length !== allowed.size ||
    changedPaths.some((path) => !allowed.has(path))
  )
    throw new LeaseReductionError(
      "reduction_candidate_invalid",
      "materialized trace contains an undeclared edit",
    );
  return Object.freeze({
    trace,
    changedPaths: Object.freeze(changedPaths),
  });
}
async function verifyMaterializedEdits<Port>(
  candidate: LeaseReductionCandidate,
  suite: SuiteDefinition<Port>,
): Promise<void> {
  const reference = suite.replay.traces[candidate.traceIndex];
  if (reference === undefined)
    throw new LeaseReductionError(
      "reduction_candidate_invalid",
      "materialized trace occurrence is missing",
    );
  const path = typeof reference === "string" ? reference : reference.path;
  const trace = JSON.parse(await readFile(path, "utf8")) as {
    states?: Record<string, unknown>[];
  };
  if (!Array.isArray(trace.states))
    throw new LeaseReductionError(
      "reduction_candidate_invalid",
      "materialized trace has no states",
    );
  if (
    suite.replay.traces.length !== candidate.traceOccurrences.length ||
    suite.replay.traces.some((_trace, index) =>
      index !== candidate.traceOccurrences[index]
    )
  )
    throw new LeaseReductionError(
      "reduction_candidate_invalid",
      "materialized corpus does not preserve the declared trace occurrences",
    );
  const actionVariable = suite.model.descriptor.runProfile.actionVariable;
  const parameterVariable =
    suite.model.descriptor.runProfile.configuredParamVar ?? "parameters";
  for (const edit of candidate.edits) {
    const state = trace.states[edit.stateIndex];
    const action = suite.model.descriptor.actions.find(
      (item) => item.id === edit.actionId,
    );
    if (!state || !action || state[actionVariable] !== action.wireAction)
      throw new LeaseReductionError(
        "reduction_candidate_invalid",
        "materialized action does not match requested edit",
      );
    const parameters = state[parameterVariable];
    const field = edit.inputId === "Client" ? "client" : "token";
    if (
      !parameters ||
      typeof parameters !== "object" ||
      rawBigint((parameters as Record<string, unknown>)[field]) !==
        String(edit.after)
    )
      throw new LeaseReductionError(
        "reduction_candidate_invalid",
        "materialized input does not match requested edit",
      );
  }
}
function receiptMatches(
  receipt: LeaseOracleReceipt,
  candidate: LeaseReductionCandidate,
  authority: LeaseReductionAuthority,
  preflight: SuitePreflight,
): boolean {
  return (
    receipt.schema === "mirrorecma.lease-reduction-oracle/v1" &&
    receipt.status === "model_valid" &&
    receipt.profile === authority.profile &&
    receipt.domainVersion === authority.domainVersion &&
    receipt.modelSha256 === candidate.modelSha256 &&
    receipt.interfaceDigest === candidate.interfaceDigest &&
    receipt.originalCorpusSha256 === candidate.orderedCorpusSha256 &&
    receipt.candidateCorpusSha256 === preflight.corpusDigest &&
    receipt.selectedTraceSha256 === candidate.selectedTraceSha256 &&
    JSON.stringify(receipt.traceOccurrences) ===
      JSON.stringify(candidate.traceOccurrences) &&
    preflight.traceDigests.length === candidate.traceOccurrences.length &&
    new Set(preflight.traceDigests).size === 1 &&
    JSON.stringify(receipt.validator) === JSON.stringify(authority.validator) &&
    JSON.stringify(receipt.apalache) === JSON.stringify(authority.apalache) &&
    JSON.stringify(receipt.java) === JSON.stringify(authority.java)
  );
}

export async function reduceLeaseServiceInput<Port>(
  bundle: ReproductionBundle,
  options: LeaseReductionOptions<Port>,
): Promise<LeaseReductionResult> {
  const originalBundleSha256 = reproductionBundleSha256(bundle);
  const finish = (
    status: LeaseReductionResult["status"],
    fields: Omit<
      LeaseReductionResult,
      "schema" | "status" | "originalBundleSha256" | "globalMinimumClaim"
    > = {},
  ): LeaseReductionResult =>
    Object.freeze({
      schema: "mirrorecma.lease-input-reduction-result/v1",
      status,
      originalBundleSha256,
      ...fields,
      globalMinimumClaim: false as const,
    });
  if (options.applicationId !== "lease-service")
    return finish("reduction_profile_unsupported", {
      reasonCode: "reduction_profile_unsupported",
    });
  const policy = validatePolicy(options.policy);
  validateAuthority(options.authority);
  const candidate = validateLeaseReductionCandidate(options.candidate);
  if (
    !options.resettable ||
    bundle.signature.primary?.kind !== "behavioral_mismatch" ||
    bundle.signature.cleanup.status !== "succeeded" ||
    options.stability.classification !== "stable" ||
    options.stability.independence !== "confirmed" ||
    options.stability.bundleSha256 !== originalBundleSha256 ||
    candidate.originalBundleSha256 !== originalBundleSha256 ||
    candidate.modelSha256 !== bundle.identities.model.sourceClosureSha256 ||
    candidate.interfaceDigest !==
      bundle.identities.generatedInterface.semanticDigest ||
    candidate.orderedCorpusSha256 !==
      bundle.identities.corpus.orderedOccurrencesSha256 ||
    candidate.traceIndex !== bundle.signature.primary.traceIndex
  )
    return finish("inconclusive", {
      candidate,
      reasonCode: "reduction_not_eligible",
    });
  const began = performance.now();
  let materialized: Awaited<ReturnType<typeof bounded<MaterializedLeaseCandidate<Port>>>>;
  try {
    materialized = await bounded(
      (signal) => options.materialize(candidate, signal),
      Math.min(policy.oracleBudgetMs, policy.totalBudgetMs),
      options.signal,
    );
  } catch {
    return finish("inconclusive", {
      candidate,
      reasonCode: "model_oracle_error",
    });
  }
  if (materialized.status !== "completed")
    return finish(
      materialized.status === "cancelled" ? "cancelled" : "inconclusive",
      {
        candidate,
        reasonCode:
          materialized.status === "cancelled"
            ? "reduction_cancelled"
            : "model_oracle_timeout",
      },
    );
  if (options.signal?.aborted)
    return finish("cancelled", {
      candidate,
      reasonCode: "reduction_cancelled",
    });
  const oracleElapsed = performance.now() - began;
  const oracleRemaining = Math.floor(policy.oracleBudgetMs - oracleElapsed);
  const totalRemaining = Math.floor(policy.totalBudgetMs - oracleElapsed);
  if (oracleRemaining <= 0 || totalRemaining <= 0)
    return finish("inconclusive", {
      candidate,
      oracle: materialized.value.receipt,
      reasonCode: "model_oracle_timeout",
    });
  let inspected: Awaited<ReturnType<typeof bounded<SuitePreflight>>>;
  try {
    inspected = await bounded(
      async () => {
        const preflight = await preflightSuite(materialized.value.suite);
        await verifyMaterializedEdits(candidate, materialized.value.suite);
        return preflight;
      },
      Math.min(oracleRemaining, totalRemaining),
      options.signal,
    );
  } catch {
    return finish("inconclusive", {
      candidate,
      oracle: materialized.value.receipt,
      reasonCode: "model_oracle_error",
    });
  }
  if (inspected.status !== "completed")
    return finish(
      inspected.status === "cancelled" ? "cancelled" : "inconclusive",
      {
        candidate,
        oracle: materialized.value.receipt,
        reasonCode:
          inspected.status === "cancelled"
            ? "reduction_cancelled"
            : "model_oracle_timeout",
      },
    );
  const preflight = inspected.value;
  if (
    preflight.modelDigest !== candidate.modelSha256 ||
    materialized.value.suite.model.semanticDigest !== candidate.interfaceDigest
  )
    return finish("inconclusive", {
      candidate,
      reasonCode: "model_or_interface_identity_mismatch",
    });
  if (
    !receiptMatches(
      materialized.value.receipt,
      candidate,
      options.authority,
      preflight,
    )
  )
    return finish("inconclusive", {
      candidate,
      reasonCode: "model_oracle_receipt_mismatch",
    });
  const remaining = policy.totalBudgetMs - (performance.now() - began);
  if (remaining <= 0)
    return finish("inconclusive", {
      candidate,
      oracle: materialized.value.receipt,
      reasonCode: "reduction_total_budget",
    });
  const replay = await bounded(
    (signal) => options.evaluate(materialized.value.suite, signal),
    Math.max(1, Math.min(policy.evaluationBudgetMs, Math.floor(remaining))),
    options.signal,
  );
  if (replay.status !== "completed") {
    const settled = await awaitReplayCleanup(
      replay.pending,
      policy.cleanupBudgetMs,
    );
    const settledCleanup =
      settled?.suiteResult?.cleanup.status ??
      settled?.observed?.cleanup.status ??
      "unconfirmed";
    return finish(
      replay.status === "cancelled" ? "cancelled" : "inconclusive",
      {
        candidate,
        oracle: materialized.value.receipt,
        preflight: {
          modelDigest: preflight.modelDigest,
          corpusDigest: preflight.corpusDigest,
        },
        reasonCode:
          settledCleanup !== "succeeded"
            ? "cleanup_independence_lost"
            : replay.status === "cancelled"
              ? "reduction_cancelled"
              : "candidate_evaluation_timeout",
      },
    );
  }
  const cleanup =
    replay.value.suiteResult?.cleanup.status ??
    replay.value.observed?.cleanup.status ??
    "unconfirmed";
  if (cleanup !== "succeeded")
    return finish("inconclusive", {
      candidate,
      oracle: materialized.value.receipt,
      replay: replay.value,
      reasonCode: "cleanup_independence_lost",
    });
  return finish(
    replayResultMatchesBundle(bundle, replay.value)
      ? "reduced"
      : "not_reproduced",
    {
      candidate,
      oracle: materialized.value.receipt,
      preflight: {
        modelDigest: preflight.modelDigest,
        corpusDigest: preflight.corpusDigest,
      },
      replay: replay.value,
      ...(options.authority.java.distributionQualified
        ? {}
        : { reasonCode: "fresh_trace_profile_unqualified_java" }),
    },
  );
}
