import { performance } from "node:perf_hooks";
import {
  parseBoundedJsonValue,
  signatureFromSuiteResult,
  signaturesEqual,
  validateEvidenceArtifactReferences,
  validateEvidenceRunReference,
  type CatalogSelectionRef,
  type EvidenceArtifactRef,
  type EvidenceRunRef,
  type ReproductionPrimarySignature,
} from "./reproduction-bundle.js";
import type { SuiteResult } from "./suite-result.js";

const SHA256 = /^[a-f0-9]{64}$/;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
type UnknownRecord = Record<string, unknown>;

export interface MutationIdentity {
  readonly id: string;
  readonly sha256: string;
}
export interface MutationProtectedInputs {
  readonly suite: MutationIdentity;
  readonly model: MutationIdentity;
  readonly generatedInterface: MutationIdentity;
  readonly corpus: MutationIdentity;
  readonly acceptance: MutationIdentity;
  readonly observer: MutationIdentity;
  readonly correctImplementation: MutationIdentity;
  readonly probes: readonly MutationIdentity[];
  readonly executionProfiles: readonly MutationIdentity[];
}
export type MutationPathSupport =
  | { readonly support: "required" | "optional" }
  | { readonly support: "unsupported"; readonly reason: string };
export interface MutationExpectedMismatch {
  readonly kind: "behavioral_mismatch";
  readonly code: "replay_mismatch";
  readonly traceIndex: number;
  readonly stateIndex: number;
  readonly action: string;
}
export interface MutationDefinition {
  readonly id: string;
  readonly implementation: MutationIdentity;
  readonly expected: MutationExpectedMismatch;
  readonly resetPlanId: string;
  readonly probeIds: readonly string[];
  readonly paths: {
    readonly local: MutationPathSupport;
    readonly gate: MutationPathSupport;
  };
}
export interface MutationCampaign {
  readonly schema: "mirrorecma.mutation-campaign/v1";
  readonly id: string;
  readonly revision: number;
  readonly evidenceLinks: {
    readonly catalogSelectionRef: CatalogSelectionRef;
    readonly runRef?: EvidenceRunRef;
    readonly artifactRefs?: readonly EvidenceArtifactRef[];
  };
  readonly denominator: number;
  readonly protected: MutationProtectedInputs;
  readonly mutants: readonly MutationDefinition[];
}
export class MutationCampaignError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MutationCampaignError";
    this.code = code;
  }
}
function fail(code: string, message: string): never {
  throw new MutationCampaignError(code, message);
}
function record(value: unknown, where: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("campaign_schema_invalid", `${where} must be an object`);
  return value as UnknownRecord;
}
function own(value: UnknownRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor))
    fail("campaign_non_data_property", `${key} must be a data property`);
  return descriptor.value;
}
function exact(
  value: UnknownRecord,
  keys: readonly string[],
  where: string,
): void {
  if (
    JSON.stringify(Object.getOwnPropertyNames(value).sort()) !==
    JSON.stringify([...keys].sort())
  )
    fail("campaign_schema_invalid", `${where} has unknown or missing fields`);
}
function text(value: unknown, where: string, pattern = STABLE_ID): string {
  if (typeof value !== "string" || !pattern.test(value))
    fail("campaign_schema_invalid", `${where} is invalid`);
  return value;
}
function integer(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail("campaign_schema_invalid", `${where} is invalid`);
  return value as number;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as UnknownRecord)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze)) as T;
  if (value && typeof value === "object") {
    const result = Object.create(null) as UnknownRecord;
    for (const key of Object.getOwnPropertyNames(value))
      result[key] = freeze(own(value as UnknownRecord, key));
    return Object.freeze(result) as T;
  }
  return value;
}
function identity(value: unknown, where: string): void {
  const item = record(value, where);
  exact(item, ["id", "sha256"], where);
  text(own(item, "id"), `${where}.id`);
  text(own(item, "sha256"), `${where}.sha256`, SHA256);
}
function catalog(value: unknown): void {
  const item = record(value, "catalogSelectionRef");
  exact(
    item,
    ["schemaVersion", "selectionKind", "selectionValue"],
    "catalogSelectionRef",
  );
  if (own(item, "schemaVersion") !== "mirrors.framework-catalog/v1")
    fail("campaign_catalog_invalid", "catalog schema mismatch");
  const kind = own(item, "selectionKind");
  const selected = own(item, "selectionValue");
  if (
    typeof selected !== "string" ||
    (kind === "sha256"
      ? !SHA256.test(selected)
      : kind === "git-revision"
        ? !/^[a-f0-9]{40}$/.test(selected)
        : true)
  )
    fail("campaign_catalog_invalid", "catalog selection invalid");
}
function path(value: unknown, where: string): void {
  const item = record(value, where);
  if (own(item, "support") === "unsupported") {
    exact(item, ["support", "reason"], where);
    if (
      typeof own(item, "reason") !== "string" ||
      !(own(item, "reason") as string)
    )
      fail("campaign_schema_invalid", "unsupported path needs reason");
  } else {
    exact(item, ["support"], where);
    if (!["required", "optional"].includes(String(own(item, "support"))))
      fail("campaign_schema_invalid", "invalid path support");
  }
}
export interface MutationCampaignValidationOptions {
  readonly knownActions?: ReadonlySet<string>;
}
export function validateMutationCampaign(
  value: unknown,
  options: MutationCampaignValidationOptions = {},
): MutationCampaign {
  const campaign = record(value, "campaign");
  exact(
    campaign,
    [
      "schema",
      "id",
      "revision",
      "evidenceLinks",
      "denominator",
      "protected",
      "mutants",
    ],
    "campaign",
  );
  if (own(campaign, "schema") !== "mirrorecma.mutation-campaign/v1")
    fail("campaign_schema_unsupported", "unsupported campaign schema");
  text(own(campaign, "id"), "campaign id");
  if (integer(own(campaign, "revision"), "revision") < 1)
    fail("campaign_schema_invalid", "revision must be positive");
  const links = record(own(campaign, "evidenceLinks"), "evidenceLinks");
  const linkKeys = Object.getOwnPropertyNames(links);
  if (
    !linkKeys.includes("catalogSelectionRef") ||
    linkKeys.some(
      (key) => !["catalogSelectionRef", "runRef", "artifactRefs"].includes(key),
    )
  )
    fail("campaign_schema_invalid", "invalid evidence links");
  catalog(own(links, "catalogSelectionRef"));
  if (Object.hasOwn(links, "runRef"))
    validateEvidenceRunReference(own(links, "runRef"));
  if (Object.hasOwn(links, "artifactRefs"))
    validateEvidenceArtifactReferences(own(links, "artifactRefs"));
  const protectedInputs = record(own(campaign, "protected"), "protected");
  exact(
    protectedInputs,
    [
      "suite",
      "model",
      "generatedInterface",
      "corpus",
      "acceptance",
      "observer",
      "correctImplementation",
      "probes",
      "executionProfiles",
    ],
    "protected",
  );
  for (const key of [
    "suite",
    "model",
    "generatedInterface",
    "corpus",
    "acceptance",
    "observer",
    "correctImplementation",
  ])
    identity(own(protectedInputs, key), `protected.${key}`);
  for (const key of ["probes", "executionProfiles"]) {
    const items = own(protectedInputs, key);
    if (!Array.isArray(items) || !items.length || items.length > 64)
      fail("campaign_schema_invalid", `${key} invalid`);
    items.forEach((item, index) => identity(item, `${key}[${index}]`));
    const ids = items.map((item) => String((item as UnknownRecord).id));
    if (new Set(ids).size !== ids.length)
      fail("campaign_identity_duplicate", `duplicate ${key} identity`);
  }
  const protectedProbeIds = new Set(
    (own(protectedInputs, "probes") as UnknownRecord[]).map((item) =>
      String(item.id),
    ),
  );
  const mutants = own(campaign, "mutants");
  const denominator = integer(own(campaign, "denominator"), "denominator");
  if (
    !Array.isArray(mutants) ||
    !mutants.length ||
    mutants.length > 256 ||
    denominator !== mutants.length
  )
    fail("campaign_denominator_invalid", "campaign denominator mismatch");
  const ids = new Set<string>();
  for (const [index, raw] of mutants.entries()) {
    const mutant = record(raw, `mutant[${index}]`);
    exact(
      mutant,
      ["id", "implementation", "expected", "resetPlanId", "probeIds", "paths"],
      `mutant[${index}]`,
    );
    const id = text(own(mutant, "id"), "mutant id");
    if (ids.has(id)) fail("campaign_mutant_duplicate", "duplicate mutant id");
    ids.add(id);
    identity(own(mutant, "implementation"), "mutant implementation");
    const expected = record(own(mutant, "expected"), "expected");
    exact(
      expected,
      ["kind", "code", "traceIndex", "stateIndex", "action"],
      "expected",
    );
    const action = text(own(expected, "action"), "expected action");
    if (
      own(expected, "kind") !== "behavioral_mismatch" ||
      own(expected, "code") !== "replay_mismatch" ||
      integer(own(expected, "traceIndex"), "trace index") < 0 ||
      integer(own(expected, "stateIndex"), "state index") < 0 ||
      (options.knownActions && !options.knownActions.has(action))
    )
      fail("campaign_expected_invalid", "invalid expected mismatch");
    text(own(mutant, "resetPlanId"), "reset plan");
    const probeIds = own(mutant, "probeIds");
    if (
      !Array.isArray(probeIds) ||
      !probeIds.length ||
      new Set(probeIds).size !== probeIds.length
    )
      fail("campaign_probe_invalid", "probe scope invalid");
    probeIds.forEach((probeId) => text(probeId, "probe id"));
    if (probeIds.some((probeId) => !protectedProbeIds.has(String(probeId))))
      fail(
        "campaign_probe_invalid",
        "mutant probe does not resolve to a protected probe",
      );
    const paths = record(own(mutant, "paths"), "paths");
    exact(paths, ["local", "gate"], "paths");
    path(own(paths, "local"), "local path");
    path(own(paths, "gate"), "gate path");
  }
  return freeze(campaign) as unknown as MutationCampaign;
}
export function decodeMutationCampaign(
  raw: string | Uint8Array,
  options: MutationCampaignValidationOptions = {},
): MutationCampaign {
  return validateMutationCampaign(parseBoundedJsonValue(raw), options);
}
export function assertMutationProtectedInputs(
  campaign: MutationCampaign,
  observed: MutationProtectedInputs,
): void {
  if (canonical(campaign.protected) !== canonical(observed))
    fail("campaign_protected_drift", "protected campaign inputs drifted");
}

export interface MutationCleanupOutcome {
  readonly scope: "local-cooperative" | "gate-physical";
  readonly requirement: "required" | "optional" | "not-applicable";
  readonly status: "confirmed" | "failed" | "unconfirmed" | "not_applicable";
  readonly code?: string;
}
export interface MutationProbeResult {
  readonly status: "passed" | "failed" | "error" | "timed_out" | "not_run";
  readonly code?: string;
}
export interface MutationEvaluation {
  readonly suiteResult: SuiteResult;
  readonly cleanup?: readonly MutationCleanupOutcome[];
  readonly probe: MutationProbeResult;
  readonly evidenceRef?: Readonly<Record<string, unknown>>;
}
export interface MutationCase {
  readonly kind: "correct" | "mutant";
  readonly id: string;
  readonly implementation: MutationIdentity;
  readonly mutant?: MutationDefinition;
}
export interface MutationCampaignPolicy {
  readonly maxMutants: number;
  readonly totalBudgetMs: number;
  readonly perRunBudgetMs: number;
  readonly cleanupBudgetMs: number;
}
export type MutationClassification =
  | "killed_by_behavioral_mismatch"
  | "survived"
  | "invalid_mutant"
  | "infrastructure_failure"
  | "inconclusive";
export interface MutationCaseResult {
  readonly id: string;
  readonly testedPath: "local" | "gate";
  readonly disposition: "attempted" | "unsupported" | "not_run";
  readonly classification?: MutationClassification;
  readonly expected?: MutationExpectedMismatch;
  readonly observed?: ReproductionPrimarySignature | null;
  readonly cleanup?: readonly MutationCleanupOutcome[];
  readonly probe?: MutationProbeResult;
  readonly reasonCode?: string;
  readonly durationMs: number;
  readonly rawEvaluation?: MutationEvaluation;
}
export interface MutationCampaignResult {
  readonly schema: "mirrorecma.mutation-campaign-result/v1";
  readonly campaignId: string;
  readonly revision: number;
  readonly testedPath: "local" | "gate";
  readonly denominator: number;
  readonly requiredOnPath: number;
  readonly status: "complete" | "incomplete" | "cancelled" | "baseline_failed";
  readonly acceptance: {
    readonly status: "met" | "unmet" | "incomplete";
    readonly reasonCodes: readonly string[];
  };
  readonly baseline: MutationCaseResult;
  readonly mutants: readonly MutationCaseResult[];
}
export interface RunMutationCampaignOptions {
  readonly path: "local" | "gate";
  readonly observedProtected: MutationProtectedInputs;
  readonly observeProtected?: (
    signal: AbortSignal,
  ) => MutationProtectedInputs | Promise<MutationProtectedInputs>;
  readonly policy: MutationCampaignPolicy;
  readonly signal?: AbortSignal;
  readonly evaluate: (
    scenario: MutationCase,
    signal: AbortSignal,
  ) => Promise<MutationEvaluation>;
}
function validatePolicy(value: MutationCampaignPolicy): MutationCampaignPolicy {
  if (
    !Number.isSafeInteger(value.maxMutants) ||
    value.maxMutants < 1 ||
    value.maxMutants > 256 ||
    !Number.isSafeInteger(value.totalBudgetMs) ||
    value.totalBudgetMs < 1 ||
    value.totalBudgetMs > 0x7fffffff ||
    !Number.isSafeInteger(value.perRunBudgetMs) ||
    value.perRunBudgetMs < 1 ||
    value.perRunBudgetMs > 0x7fffffff ||
    !Number.isSafeInteger(value.cleanupBudgetMs) ||
    value.cleanupBudgetMs < 1 ||
    value.cleanupBudgetMs > 0x7fffffff
  )
    throw new TypeError("invalid mutation campaign policy");
  return Object.freeze({ ...value });
}
function cleanupOf(
  evaluation: MutationEvaluation,
): readonly MutationCleanupOutcome[] {
  if (evaluation.cleanup) return evaluation.cleanup;
  const status = evaluation.suiteResult.cleanup.status;
  return Object.freeze([
    {
      scope: "local-cooperative",
      requirement: "required",
      status: status === "succeeded" ? "confirmed" : status,
      ...(status === "succeeded" ? {} : { code: `local_cleanup_${status}` }),
    },
  ]) as readonly MutationCleanupOutcome[];
}
function cleanupConfirmed(
  cleanup: readonly MutationCleanupOutcome[],
  path: "local" | "gate",
): boolean {
  if (!cleanup.length) return false;
  const scopes = cleanup.map((item) => item.scope);
  if (new Set(scopes).size !== scopes.length) return false;
  for (const item of cleanup) {
    if (
      (item.requirement === "not-applicable") !==
      (item.status === "not_applicable")
    )
      return false;
    if (item.requirement === "required" && item.status !== "confirmed")
      return false;
  }
  const requiredScope =
    path === "local" ? "local-cooperative" : "gate-physical";
  return cleanup.some(
    (item) =>
      item.scope === requiredScope &&
      item.requirement === "required" &&
      item.status === "confirmed",
  );
}
function caseResult(
  value: Omit<MutationCaseResult, "rawEvaluation">,
  raw?: MutationEvaluation,
): MutationCaseResult {
  const result: MutationCaseResult = { ...value };
  if (raw)
    Object.defineProperty(result, "rawEvaluation", {
      value: raw,
      enumerable: false,
    });
  return Object.freeze(result);
}
function classify(
  mutant: MutationDefinition,
  evaluation: MutationEvaluation,
  testedPath: "local" | "gate",
  durationMs: number,
): MutationCaseResult {
  const cleanup = cleanupOf(evaluation);
  const signature =
    evaluation.suiteResult.failure?.kind === "mismatch"
      ? signatureFromSuiteResult(evaluation.suiteResult)
      : null;
  const observed = signature?.primary ?? null;
  const expectedSignature = {
    primary: mutant.expected,
    cleanup: { status: "succeeded" as const },
  };
  let classification: MutationClassification;
  if (
    signature &&
    signaturesEqual(signature, expectedSignature) &&
    cleanupConfirmed(cleanup, testedPath) &&
    evaluation.probe.status === "passed"
  )
    classification = "killed_by_behavioral_mismatch";
  else if (
    evaluation.suiteResult.outcome === "passed" &&
    cleanupConfirmed(cleanup, testedPath) &&
    evaluation.probe.status === "passed"
  )
    classification = "survived";
  else if (
    evaluation.suiteResult.failure?.kind === "configuration" ||
    evaluation.suiteResult.failure?.kind === "negotiation" ||
    evaluation.suiteResult.failure?.stage === "factory"
  )
    classification = "invalid_mutant";
  else if (
    evaluation.suiteResult.failure?.kind === "transport" ||
    evaluation.suiteResult.failure?.kind === "unknown"
  )
    classification = "infrastructure_failure";
  else classification = "inconclusive";
  return caseResult(
    {
      id: mutant.id,
      testedPath,
      disposition: "attempted",
      classification,
      expected: mutant.expected,
      observed,
      cleanup,
      probe: evaluation.probe,
      durationMs,
    },
    evaluation,
  );
}
async function boundedEvaluation(
  run: (signal: AbortSignal) => Promise<MutationEvaluation>,
  parent: AbortSignal | undefined,
  runMs: number,
  cleanupMs: number,
  testedPath: "local" | "gate",
): Promise<{
  evaluation?: MutationEvaluation;
  timedOut?: boolean;
  cancelled?: boolean;
  cleanupConfirmed: boolean;
}> {
  if (parent?.aborted) return { cancelled: true, cleanupConfirmed: true };
  const controller = new AbortController();
  const forward = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", forward, { once: true });
  const pending = Promise.resolve().then(() => {
    if (controller.signal.aborted)
      throw new Error("campaign cancelled before evaluator start");
    return run(controller.signal);
  });
  void pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const boundary = new Promise<"timeout" | "cancel">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), runMs);
    parent?.addEventListener("abort", () => resolve("cancel"), { once: true });
  });
  const first = await Promise.race([
    pending.then((evaluation) => ({ evaluation })),
    boundary.then((kind) => ({ kind })),
  ]);
  if (timer) clearTimeout(timer);
  parent?.removeEventListener("abort", forward);
  if ("evaluation" in first)
    return {
      evaluation: first.evaluation,
      cleanupConfirmed: cleanupConfirmed(
        cleanupOf(first.evaluation),
        testedPath,
      ),
    };
  controller.abort(first.kind);
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    pending.catch(() => undefined),
    new Promise<undefined>((resolve) => {
      cleanupTimer = setTimeout(() => resolve(undefined), cleanupMs);
    }),
  ]);
  if (cleanupTimer) clearTimeout(cleanupTimer);
  return {
    ...(first.kind === "timeout" ? { timedOut: true } : { cancelled: true }),
    evaluation: settled,
    cleanupConfirmed: settled
      ? cleanupConfirmed(cleanupOf(settled), testedPath)
      : false,
  };
}

export async function runMutationCampaign(
  campaignInput: MutationCampaign,
  options: RunMutationCampaignOptions,
): Promise<MutationCampaignResult> {
  const campaign = validateMutationCampaign(campaignInput);
  const policy = validatePolicy(options.policy);
  const began = performance.now();
  const observeProtected =
    options.observeProtected ?? (() => options.observedProtected);
  const checkProtected = async () => {
    const remaining = policy.totalBudgetMs - (performance.now() - began);
    if (remaining <= 0)
      fail(
        "campaign_total_budget",
        "campaign budget expired during protected identity observation",
      );
    const controller = new AbortController();
    const forward = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forward, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted)
        fail(
          "campaign_cancelled",
          "campaign cancelled before identity observation",
        );
      return observeProtected(controller.signal);
    });
    void pending.catch(() => {});
    const boundary = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          controller.abort("identity observation timeout");
          reject(
            new MutationCampaignError(
              "campaign_protected_timeout",
              "protected identity observation timed out",
            ),
          );
        },
        Math.max(1, Math.min(policy.perRunBudgetMs, Math.floor(remaining))),
      );
      abort = () => {
        controller.abort(options.signal?.reason);
        reject(
          new MutationCampaignError(
            "campaign_cancelled",
            "campaign cancelled during identity observation",
          ),
        );
      };
      options.signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      assertMutationProtectedInputs(
        campaign,
        await Promise.race([pending, boundary]),
      );
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", forward);
      options.signal?.removeEventListener("abort", abort);
    }
  };
  await checkProtected();
  if (campaign.denominator > policy.maxMutants)
    fail("campaign_mutant_limit", "campaign exceeds configured mutant limit");
  const baselineStart = performance.now();
  let baselineBounded:
    | Awaited<ReturnType<typeof boundedEvaluation>>
    | undefined;
  try {
    baselineBounded = await boundedEvaluation(
      (signal) =>
        options.evaluate(
          {
            kind: "correct",
            id: "correct",
            implementation: campaign.protected.correctImplementation,
          },
          signal,
        ),
      options.signal,
      Math.min(policy.perRunBudgetMs, policy.totalBudgetMs),
      policy.cleanupBudgetMs,
      options.path,
    );
  } catch {
    baselineBounded = undefined;
  }
  let baseline: MutationCaseResult;
  if (!baselineBounded?.evaluation)
    baseline = caseResult({
      id: "correct",
      testedPath: options.path,
      disposition: "attempted",
      classification: baselineBounded?.timedOut
        ? "inconclusive"
        : "infrastructure_failure",
      reasonCode: baselineBounded?.timedOut
        ? "baseline_timeout"
        : "baseline_failed",
      durationMs: performance.now() - baselineStart,
    });
  else {
    const evaluation = baselineBounded.evaluation;
    const cleanup = cleanupOf(evaluation);
    const accepted =
      evaluation.suiteResult.outcome === "passed" &&
      cleanupConfirmed(cleanup, options.path) &&
      evaluation.probe.status === "passed" &&
      baselineBounded.cleanupConfirmed &&
      !baselineBounded.timedOut &&
      !baselineBounded.cancelled;
    baseline = caseResult(
      {
        id: "correct",
        testedPath: options.path,
        disposition: "attempted",
        classification: accepted ? "survived" : "inconclusive",
        cleanup,
        probe: evaluation.probe,
        reasonCode: accepted ? undefined : "baseline_not_accepted",
        durationMs: performance.now() - baselineStart,
      },
      evaluation,
    );
  }
  const selected = campaign.mutants.filter(
    (mutant) => mutant.paths[options.path].support !== "unsupported",
  );
  const unsupported = campaign.mutants.filter(
    (mutant) => mutant.paths[options.path].support === "unsupported",
  );
  const results: MutationCaseResult[] = unsupported.map((mutant) =>
    caseResult({
      id: mutant.id,
      testedPath: options.path,
      disposition: "unsupported",
      expected: mutant.expected,
      reasonCode: (mutant.paths[options.path] as { reason: string }).reason,
      durationMs: 0,
    }),
  );
  if (baseline.classification !== "survived")
    return Object.freeze({
      schema: "mirrorecma.mutation-campaign-result/v1",
      campaignId: campaign.id,
      revision: campaign.revision,
      testedPath: options.path,
      denominator: campaign.denominator,
      requiredOnPath: selected.filter(
        (mutant) => mutant.paths[options.path].support === "required",
      ).length,
      status: options.signal?.aborted ? "cancelled" : "baseline_failed",
      acceptance: Object.freeze({
        status: "incomplete" as const,
        reasonCodes: Object.freeze(["baseline_not_accepted"]),
      }),
      baseline,
      mutants: Object.freeze([
        ...results,
        ...selected.map((mutant) =>
          caseResult({
            id: mutant.id,
            testedPath: options.path,
            disposition: "not_run",
            expected: mutant.expected,
            reasonCode: "baseline_not_accepted",
            durationMs: 0,
          }),
        ),
      ]),
    });
  let status: MutationCampaignResult["status"] = "complete";
  let stopReason = "campaign_stopped";
  for (const mutant of selected) {
    if (options.signal?.aborted) {
      status = "cancelled";
      stopReason = "campaign_cancelled";
      break;
    }
    const remaining = policy.totalBudgetMs - (performance.now() - began);
    if (remaining <= 0) {
      status = "incomplete";
      stopReason = "total_budget_exhausted";
      break;
    }
    try {
      await checkProtected();
    } catch (error) {
      status = "incomplete";
      stopReason =
        error instanceof MutationCampaignError
          ? error.code
          : "campaign_protected_drift";
      break;
    }
    const started = performance.now();
    try {
      const bounded = await boundedEvaluation(
        (signal) =>
          options.evaluate(
            {
              kind: "mutant",
              id: mutant.id,
              implementation: mutant.implementation,
              mutant,
            },
            signal,
          ),
        options.signal,
        Math.max(1, Math.min(policy.perRunBudgetMs, Math.floor(remaining))),
        policy.cleanupBudgetMs,
        options.path,
      );
      if (bounded.timedOut || bounded.cancelled) {
        const evaluation = bounded.evaluation;
        results.push(
          caseResult(
            {
              id: mutant.id,
              testedPath: options.path,
              disposition: "attempted",
              classification: "inconclusive",
              expected: mutant.expected,
              ...(evaluation
                ? {
                    observed:
                      evaluation.suiteResult.failure?.kind === "mismatch"
                        ? (signatureFromSuiteResult(evaluation.suiteResult)
                            ?.primary ?? null)
                        : null,
                    cleanup: cleanupOf(evaluation),
                    probe: evaluation.probe,
                  }
                : {}),
              reasonCode: bounded.cancelled
                ? "campaign_cancelled"
                : "run_timeout",
              durationMs: performance.now() - started,
            },
            evaluation,
          ),
        );
        status = bounded.cancelled ? "cancelled" : "incomplete";
        stopReason = bounded.cancelled ? "campaign_cancelled" : "run_timeout";
        break;
      } else if (!bounded.evaluation) {
        results.push(
          caseResult({
            id: mutant.id,
            testedPath: options.path,
            disposition: "attempted",
            classification: bounded.timedOut
              ? "inconclusive"
              : "infrastructure_failure",
            expected: mutant.expected,
            reasonCode: bounded.timedOut ? "run_timeout" : "evaluation_failed",
            durationMs: performance.now() - started,
          }),
        );
        status = bounded.cancelled ? "cancelled" : "incomplete";
        stopReason = bounded.cancelled
          ? "campaign_cancelled"
          : "evaluation_failed";
        if (!bounded.cleanupConfirmed) break;
      } else {
        results.push(
          classify(
            mutant,
            bounded.evaluation,
            options.path,
            performance.now() - started,
          ),
        );
        if (!bounded.cleanupConfirmed) {
          status = "incomplete";
          stopReason = "cleanup_independence_lost";
          break;
        }
      }
    } catch {
      results.push(
        caseResult({
          id: mutant.id,
          testedPath: options.path,
          disposition: "attempted",
          classification: "infrastructure_failure",
          expected: mutant.expected,
          reasonCode: "evaluator_threw",
          durationMs: performance.now() - started,
        }),
      );
      status = "incomplete";
      stopReason = "evaluator_threw";
      break;
    }
  }
  const attempted = new Set(results.map((result) => result.id));
  for (const mutant of selected)
    if (!attempted.has(mutant.id))
      results.push(
        caseResult({
          id: mutant.id,
          testedPath: options.path,
          disposition: "not_run",
          expected: mutant.expected,
          reasonCode:
            status === "cancelled" ? "campaign_cancelled" : stopReason,
          durationMs: 0,
        }),
      );
  const requiredIds = new Set(
    selected
      .filter((mutant) => mutant.paths[options.path].support === "required")
      .map((mutant) => mutant.id),
  );
  const requiredResults = results.filter((result) =>
    requiredIds.has(result.id),
  );
  let acceptanceStatus: MutationCampaignResult["acceptance"]["status"];
  let reasonCodes: string[];
  if (
    status !== "complete" ||
    requiredResults.length !== requiredIds.size ||
    requiredResults.some((result) => result.disposition !== "attempted")
  ) {
    acceptanceStatus = "incomplete";
    reasonCodes = [stopReason];
  } else if (
    requiredResults.some((result) => result.classification === "survived")
  ) {
    acceptanceStatus = "unmet";
    reasonCodes = ["required_mutant_survived"];
  } else if (
    requiredResults.some(
      (result) => result.classification !== "killed_by_behavioral_mismatch",
    )
  ) {
    acceptanceStatus = "incomplete";
    reasonCodes = ["required_mutant_inconclusive"];
  } else {
    acceptanceStatus = "met";
    reasonCodes = [];
  }
  return Object.freeze({
    schema: "mirrorecma.mutation-campaign-result/v1",
    campaignId: campaign.id,
    revision: campaign.revision,
    testedPath: options.path,
    denominator: campaign.denominator,
    requiredOnPath: selected.filter(
      (mutant) => mutant.paths[options.path].support === "required",
    ).length,
    status,
    acceptance: Object.freeze({
      status: acceptanceStatus,
      reasonCodes: Object.freeze(reasonCodes),
    }),
    baseline,
    mutants: Object.freeze(results),
  });
}
