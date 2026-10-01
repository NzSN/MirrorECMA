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
import type {
  TlsConnectTransport,
  TlsOptions,
  Transport,
} from "./transport.js";

export const LEASE_REDUCTION_SCHEMA =
  "mirrors.reduction-candidate/lease-service-input-shrink/v1" as const;
export const LEASE_REDUCTION_PROFILE = "lease-service-input-shrink/v1" as const;
export const LEASE_REDUCTION_DOMAIN_VERSION = "LeaseService.Next/v1" as const;
/** Expected remote-service identities (design §5.2). A service identity record
 *  that does not carry exactly these observations is refused before the oracle
 *  is opened. */
export const LEASE_REDUCTION_APALACHE_VERSION = "0.62.2" as const;
export const LEASE_REDUCTION_JAVA_OBSERVED_VERSION = "25.0.4+7-LTS" as const;
export type LeaseReductionOracleMode = "local" | "remote";
const SHA256 = /^[a-f0-9]{64}$/;
const ISO8601_UTC =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/;

export interface LeaseReductionServiceEndpoint {
  readonly host: string;
  readonly port: number;
}
/**
 * Operator-observed identity of the deployed model-check service (design §5.2
 * step 3). The record is evaluator-owned evidence cited by the receipt; the
 * reducer never invents or refreshes it. Validation is strict and closed.
 */
export interface LeaseReductionServiceIdentity {
  readonly endpoint: LeaseReductionServiceEndpoint;
  readonly peerLeafSha256: string;
  readonly apalacheVersion: typeof LEASE_REDUCTION_APALACHE_VERSION;
  readonly javaVersion: typeof LEASE_REDUCTION_JAVA_OBSERVED_VERSION;
  readonly observedAt: string;
  readonly qualificationRef: string;
}
function serviceRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LeaseReductionError(
      "reduction_service_identity_invalid",
      `${label} must be an object`,
    );
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new LeaseReductionError(
      "reduction_service_identity_invalid",
      `${label} fields are invalid`,
    );
  return record;
}
/** Strictly validate one operator-observed service identity record. */
export function validateLeaseReductionServiceIdentity(
  value: unknown,
): LeaseReductionServiceIdentity {
  const record = serviceRecord(
    value,
    ["endpoint", "peerLeafSha256", "apalacheVersion", "javaVersion", "observedAt", "qualificationRef"],
    "service identity",
  );
  const endpoint = serviceRecord(record["endpoint"], ["host", "port"], "service endpoint");
  const host = endpoint["host"];
  const port = endpoint["port"];
  const peerLeafSha256 = record["peerLeafSha256"];
  const observedAt = record["observedAt"];
  const qualificationRef = record["qualificationRef"];
  if (typeof host !== "string" || host.length < 1 || host.length > 253 || !HOST.test(host))
    throw new LeaseReductionError(
      "reduction_service_identity_invalid",
      "service endpoint host is invalid",
    );
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535)
    throw new LeaseReductionError(
      "reduction_service_identity_invalid",
      "service endpoint port is invalid",
    );
  if (typeof peerLeafSha256 !== "string" || !SHA256.test(peerLeafSha256))
    throw new LeaseReductionError(
      "reduction_service_identity_invalid",
      "service peer leaf fingerprint must be a lowercase SHA-256",
    );
  if (record["apalacheVersion"] !== LEASE_REDUCTION_APALACHE_VERSION)
    throw new LeaseReductionError(
      "reduction_service_identity_invalid",
      `service Apalache version must be ${LEASE_REDUCTION_APALACHE_VERSION}`,
    );
  if (record["javaVersion"] !== LEASE_REDUCTION_JAVA_OBSERVED_VERSION)
    throw new LeaseReductionError(
      "reduction_service_identity_invalid",
      `service Java version must be ${LEASE_REDUCTION_JAVA_OBSERVED_VERSION}`,
    );
  if (
    typeof observedAt !== "string" ||
    !ISO8601_UTC.test(observedAt) ||
    !Number.isFinite(Date.parse(observedAt))
  )
    throw new LeaseReductionError(
      "reduction_service_identity_invalid",
      "service observation timestamp must be an ISO-8601 UTC instant",
    );
  if (
    typeof qualificationRef !== "string" ||
    qualificationRef.length < 1 ||
    qualificationRef.length > 512 ||
    !PRINTABLE_ASCII.test(qualificationRef)
  )
    throw new LeaseReductionError(
      "reduction_service_identity_invalid",
      "service qualification reference is invalid",
    );
  return Object.freeze({
    endpoint: Object.freeze({ host, port: port as number }),
    peerLeafSha256,
    apalacheVersion: LEASE_REDUCTION_APALACHE_VERSION,
    javaVersion: LEASE_REDUCTION_JAVA_OBSERVED_VERSION,
    observedAt,
    qualificationRef,
  });
}

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

/* --------------------------------------------------------------------------
 * Oracle execution modes (Mirrors Plans/m3-safe-reduction-design.md section 5).
 *
 * Local mode pins byte-identical tools on this host. Remote mode runs the
 * model oracle against the deployed service over mTLS and replaces the local
 * Apalache/Java byte pins with an operator-observed service identity record.
 * Both modes keep every safety invariant of the reducer: the oracle only ever
 * witnesses model validity; application output is never the validity oracle.
 * ------------------------------------------------------------------------ */

export const LEASE_REDUCTION_TOOLS_SCHEMA_LOCAL =
  "mirrorecma.lease-reduction-tools/v1" as const;
export const LEASE_REDUCTION_TOOLS_SCHEMA_REMOTE =
  "mirrorecma.lease-reduction-tools/v2" as const;
export const LEASE_REDUCTION_ORACLE_RECEIPT_SCHEMA_V2 =
  "mirrorecma.lease-reduction-oracle/v2" as const;
export const LEASE_REDUCTION_MATERIALIZATION_FAILURE_SCHEMA_V2 =
  "mirrorecma.lease-reduction-materialization/v2" as const;
export const LEASE_REDUCTION_VALIDATOR_ID =
  "mirrors.model-interface-reduction/v1" as const;

/** Remote-mode tool manifest. Only artifacts that still execute on this host
 *  (the candidate validator) keep byte pins; Apalache and Java run on the
 *  service and are covered by the service identity record instead. */
export interface LeaseReductionRemoteTools {
  readonly schema: typeof LEASE_REDUCTION_TOOLS_SCHEMA_REMOTE;
  readonly mode: "remote";
  readonly totalBudgetMs: number;
  readonly cleanupBudgetMs: number;
  readonly validator: {
    readonly id: typeof LEASE_REDUCTION_VALIDATOR_ID;
    readonly path: string;
    readonly sha256: string;
  };
}

/** Strictly validate one remote-mode tool manifest (`...tools/v2`). */
export function validateLeaseReductionRemoteTools(
  value: unknown,
): LeaseReductionRemoteTools {
  const record = serviceRecord(
    value,
    ["schema", "mode", "totalBudgetMs", "cleanupBudgetMs", "validator"],
    "remote tool manifest",
  );
  if (record["schema"] !== LEASE_REDUCTION_TOOLS_SCHEMA_REMOTE)
    throw new LeaseReductionError(
      "reduction_tool_manifest_invalid",
      `remote tool manifest schema must be ${LEASE_REDUCTION_TOOLS_SCHEMA_REMOTE}`,
    );
  if (record["mode"] !== "remote")
    throw new LeaseReductionError(
      "reduction_tool_manifest_invalid",
      "remote tool manifest mode must be remote",
    );
  for (const key of ["totalBudgetMs", "cleanupBudgetMs"]) {
    const budget = record[key];
    if (
      typeof budget !== "number" ||
      !Number.isSafeInteger(budget) ||
      budget < 1 ||
      budget > 0x7fffffff
    )
      throw new LeaseReductionError(
        "reduction_tool_manifest_invalid",
        `${key} must be a positive bounded integer`,
      );
  }
  const validator = serviceRecord(
    record["validator"],
    ["id", "path", "sha256"],
    "remote validator identity",
  );
  if (validator["id"] !== LEASE_REDUCTION_VALIDATOR_ID)
    throw new LeaseReductionError(
      "reduction_tool_manifest_invalid",
      `remote validator id must be ${LEASE_REDUCTION_VALIDATOR_ID}`,
    );
  if (typeof validator["path"] !== "string" || validator["path"].length === 0)
    throw new LeaseReductionError(
      "reduction_tool_manifest_invalid",
      "remote validator path is invalid",
    );
  if (
    typeof validator["sha256"] !== "string" ||
    !SHA256.test(validator["sha256"])
  )
    throw new LeaseReductionError(
      "reduction_tool_manifest_invalid",
      "remote validator digest must be a lowercase SHA-256",
    );
  return Object.freeze({
    schema: LEASE_REDUCTION_TOOLS_SCHEMA_REMOTE,
    mode: "remote" as const,
    totalBudgetMs: record["totalBudgetMs"] as number,
    cleanupBudgetMs: record["cleanupBudgetMs"] as number,
    validator: Object.freeze({
      id: LEASE_REDUCTION_VALIDATOR_ID,
      path: validator["path"] as string,
      sha256: validator["sha256"] as string,
    }),
  });
}

/** TLS credential file paths for the remote oracle. Credentials are
 *  operator-supplied local files; they are not evidence and never enter the
 *  receipt. */
export interface LeaseReductionTlsPaths {
  readonly caPath: string;
  readonly certPath: string;
  readonly keyPath: string;
}

export type LeaseReductionOracleRequest =
  | { readonly mode: "local"; readonly mirrorPath: string }
  | {
      readonly mode: "remote";
      readonly service: LeaseReductionServiceIdentity;
      readonly tls: LeaseReductionTlsPaths;
    };

/** Injectable transport factories so tests never open a real connection. */
export interface LeaseReductionOracleDeps {
  readonly spawnMirror: (binPath: string) => Transport;
  readonly connectTlsMirror: (
    host: string,
    port: number,
    opts: TlsOptions,
  ) => Promise<TlsConnectTransport>;
}

export interface OracleCleanupSettlement {
  readonly status: "confirmed" | "unconfirmed";
  readonly method: "forced_transport_close";
}

/** Settle the model-oracle transport after a forced close. Only a close that
 *  resolves within the cleanup budget is confirmed; a rejected or hanging
 *  close stays unconfirmed so the caller refuses the candidate. */
export async function settleOracleCleanup(
  transport: Pick<Transport, "close">,
  budgetMs: number,
): Promise<OracleCleanupSettlement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      Promise.resolve()
        .then(() => transport.close())
        .then(
          () => "completed" as const,
          () => "failed" as const,
        ),
      new Promise<"timed_out">((resolvePromise) => {
        timer = setTimeout(() => resolvePromise("timed_out"), budgetMs);
      }),
    ]);
    return {
      status: settled === "completed" ? "confirmed" : "unconfirmed",
      method: "forced_transport_close",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Open the model-oracle transport for the selected mode. Remote mode pins
 *  the peer leaf fingerprint twice: once via the TLS pin option and once by
 *  comparing the connected transport's observed fingerprint with the service
 *  identity record, closing the transport before the mismatch error. */
export async function openReductionOracleTransport(
  request: LeaseReductionOracleRequest,
  deps: LeaseReductionOracleDeps,
): Promise<Transport> {
  if (request.mode === "local") {
    if (typeof request.mirrorPath !== "string" || request.mirrorPath.length === 0)
      throw new LeaseReductionError(
        "reduction_oracle_configuration_invalid",
        "local oracle mode requires a mirror binary path",
      );
    return deps.spawnMirror(request.mirrorPath);
  }
  const service = request.service;
  const tls = request.tls;
  if (!service || !tls)
    throw new LeaseReductionError(
      "reduction_oracle_configuration_invalid",
      "remote oracle mode requires a service identity record and TLS paths",
    );
  for (const [label, value] of [
    ["ca", tls.caPath],
    ["cert", tls.certPath],
    ["key", tls.keyPath],
  ] as const)
    if (typeof value !== "string" || value.length === 0)
      throw new LeaseReductionError(
        "reduction_oracle_configuration_invalid",
        `remote oracle mode requires a TLS ${label} path`,
      );
  let transport: TlsConnectTransport;
  try {
    transport = await deps.connectTlsMirror(service.endpoint.host, service.endpoint.port, {
      caPath: tls.caPath,
      certPath: tls.certPath,
      keyPath: tls.keyPath,
      pin: service.peerLeafSha256,
    });
  } catch (error) {
    throw new LeaseReductionError(
      "reduction_service_unreachable",
      `model-check service could not be reached: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
  if (transport.peerFingerprint !== service.peerLeafSha256) {
    try {
      await transport.close();
    } catch {
      // Preserve the identity mismatch as the primary failure.
    }
    throw new LeaseReductionError(
      "reduction_service_identity_mismatch",
      "service peer leaf fingerprint differs from the service identity record",
    );
  }
  return transport;
}

/** Apply the oracle-mode environment. Remote mode removes any inherited
 *  APALACHE_MC so no local model checker can be selected; local mode pins the
 *  launcher and prepends the selected JDK, matching the historical behavior. */
export function applyOracleModeEnvironment(
  mode: LeaseReductionOracleMode,
  env: Record<string, string | undefined>,
  local?: { readonly apalacheLauncherPath: string; readonly javaHome: string },
): void {
  if (mode === "remote") {
    delete env["APALACHE_MC"];
    return;
  }
  if (!local)
    throw new LeaseReductionError(
      "reduction_oracle_configuration_invalid",
      "local oracle mode requires the Apalache launcher and Java home",
    );
  env["APALACHE_MC"] = local.apalacheLauncherPath;
  env["PATH"] = `${local.javaHome}/bin:${env["PATH"] ?? ""}`;
}
