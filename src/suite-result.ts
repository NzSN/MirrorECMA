import type { AcceptanceAssessment, SuiteEvidence } from "./acceptance.js";
import type { CompiledReplayReport } from "./replay-report.js";
export interface SuiteFailure {
  readonly stage: "configuration" | "negotiation" | "factory" | "replay" | "acceptance" | "cleanup";
  readonly kind: "configuration" | "negotiation" | "transport" | "implementation" | "codec" | "acceptance" | "evidence" | "cleanup" | "mismatch" | "cancellation" | "timeout" | "unknown";
  readonly code: string;
  readonly message: string;
  readonly traceIndex?: number;
  readonly stateIndex?: number;
}
export interface SuiteCleanup {
  readonly scope: "local";
  readonly status: "succeeded" | "failed" | "unconfirmed";
  readonly quiescence: "confirmed" | "unconfirmed";
  readonly bindingStatus?: "not_started" | "succeeded" | "failed" | "unconfirmed";
}
export interface SuiteResult {
  readonly schema: "mirrorecma.suite-result/v1";
  readonly suiteId: string;
  readonly outcome: "passed" | "mismatch" | "failed" | "cancelled" | "timedOut";
  readonly conformance: "matched" | "mismatch" | "incomplete" | "not_evaluated";
  readonly acceptance: AcceptanceAssessment;
  readonly cleanup: SuiteCleanup;
  readonly identities: { readonly interfaceDigest: string; readonly modelDigest?: string; readonly corpusDigest?: string };
  readonly evidence: SuiteEvidence;
  readonly report?: CompiledReplayReport;
  readonly failure?: SuiteFailure;
  /** Original trusted rejection; deliberately omitted from JSON serialization. */
  readonly trustedError?: unknown;
}
