export const MAX_REQUIRED_ACTIONS = 256;
export const MAX_REQUIRED_PAIRS = 1024;
export interface AcceptanceRequirements {
  readonly requiredActions?: readonly string[];
  readonly requiredPairs?: readonly (readonly [string, string])[];
}
/** Decimal strings keep counters exact and JSON-safe, without numeric overflow. */
export interface SuiteEvidence {
  readonly schema: "mirrorecma.suite-evidence/v1";
  readonly enteredReplay: boolean;
  readonly complete: boolean;
  readonly exact: boolean;
  readonly tracesExpected: number;
  readonly tracesCompleted: number;
  readonly initializationsMatched: string;
  readonly transitionsMatched: string;
  readonly actionCounts: Readonly<Record<string, string>>;
  readonly pairCounts: Readonly<Record<string, string>>;
  readonly failure?: string;
}
export interface AcceptanceAssessment {
  readonly status: "met" | "unmet" | "incomplete" | "not_evaluated";
  readonly missingActions: readonly string[];
  readonly missingPairs: readonly (readonly [string, string])[];
}
export function acceptancePairKey(pair: readonly [string, string]): string { return JSON.stringify(pair); }
export function validateAcceptanceRequirements(input: AcceptanceRequirements, ids?: ReadonlySet<string>): AcceptanceRequirements {
  if (!input || typeof input !== "object" || Object.keys(input).some((key) => key !== "requiredActions" && key !== "requiredPairs")) throw new TypeError("invalid acceptance requirements");
  const actions = input.requiredActions ?? [];
  const pairs = input.requiredPairs ?? [];
  if (!Array.isArray(actions) || actions.length > MAX_REQUIRED_ACTIONS || !Array.isArray(pairs) || pairs.length > MAX_REQUIRED_PAIRS) throw new RangeError("acceptance requirement limit exceeded");
  const valid = (id: unknown) => typeof id === "string" && id.length > 0 && (ids === undefined || ids.has(id));
  if (actions.some((id) => !valid(id)) || pairs.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(valid))) throw new TypeError("requirements must name known transition IDs");
  if (new Set(actions).size !== actions.length || new Set(pairs.map(acceptancePairKey)).size !== pairs.length) throw new TypeError("duplicate acceptance requirement");
  return Object.freeze({ requiredActions: Object.freeze([...actions]), requiredPairs: Object.freeze(pairs.map((p) => Object.freeze([p[0], p[1]] as const))) });
}
export function evaluateAcceptance(requirements: AcceptanceRequirements, evidence: SuiteEvidence): AcceptanceAssessment {
  const checked = validateAcceptanceRequirements(requirements);
  const result = (status: AcceptanceAssessment["status"], missingActions: readonly string[] = [], missingPairs: readonly (readonly [string,string])[] = []): AcceptanceAssessment =>
    Object.freeze({status, missingActions: Object.freeze([...missingActions]), missingPairs: Object.freeze([...missingPairs])});
  if (!evidence.enteredReplay) return result("not_evaluated");
  if (!evidence.complete || !evidence.exact || !Number.isSafeInteger(evidence.tracesExpected) || evidence.tracesExpected <= 0 || evidence.tracesCompleted !== evidence.tracesExpected || evidence.initializationsMatched !== String(evidence.tracesExpected)) return result("incomplete");
  const count = (table: Readonly<Record<string,string>>, key: string): bigint | undefined => {
    const value = Object.hasOwn(table, key) ? table[key] : undefined;
    return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : undefined;
  };
  const actions = checked.requiredActions!;
  const pairs = checked.requiredPairs!;
  if (actions.some((id) => count(evidence.actionCounts,id) === undefined) || pairs.some((p) => count(evidence.pairCounts,acceptancePairKey(p)) === undefined)) return result("incomplete");
  const missingActions = actions.filter((id) => count(evidence.actionCounts,id) === 0n);
  const missingPairs = pairs.filter((p) => count(evidence.pairCounts,acceptancePairKey(p)) === 0n);
  return result(missingActions.length || missingPairs.length ? "unmet" : "met", missingActions, missingPairs);
}
