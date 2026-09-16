import { decodeSemanticDescriptor, type SemanticDescriptor } from "./model-interface.js";

export type EvidenceUncertainty = "mapping" | "protocol" | "counter_overflow" | "missing_ack" | "missing_tracker";
export interface MatchedEvidence {
  readonly schema: "mirrorecma.matched-evidence/v1";
  readonly replayEntered: boolean;
  readonly corpusCompleted: boolean;
  readonly exact: boolean;
  readonly tracesSelected: number;
  readonly tracesStarted: number;
  readonly tracesCompleted: number;
  readonly initialStatesMatched: number;
  readonly transitionsMatched: number;
  readonly statesReported: number;
  readonly requiredActionCounts: readonly { readonly id: string; readonly count: number }[];
  readonly requiredPairCounts: readonly { readonly from: string; readonly to: string; readonly count: number }[];
  readonly uncertainty: readonly EvidenceUncertainty[];
}
export class MatchedEvidenceError extends Error {
  readonly code = "evidence_invalid";
  constructor(message: string) { super(message); this.name = "MatchedEvidenceError"; }
}
const uncertaintyOrder: readonly EvidenceUncertainty[] = ["mapping", "protocol", "counter_overflow", "missing_ack", "missing_tracker"];

/** Trusted per-run tracker. It observes protocol acknowledgements, never SUT coverage. */
export class MatchedEvidenceTracker {
  private readonly actions = new Map<string, number>();
  private readonly pairs: { from: string; to: string; count: number }[];
  private readonly labels = new Map<string, { id: string; initial: boolean }>();
  private readonly lengths: readonly number[];
  private readonly uncertain = new Set<EvidenceUncertainty>();
  private entered = false;
  private complete = false;
  private sealed = false;
  private started = 0;
  private completed = 0;
  private initialMatched = 0;
  private transitionMatched = 0;
  private reportedCount = 0;
  private currentMatched = 0;
  private previous: string | undefined;
  private active: { id: string; initial: boolean } | undefined;
  private pending: { id: string; initial: boolean } | undefined;

  constructor(descriptor: SemanticDescriptor,
    requirements: { readonly requiredActions: readonly string[]; readonly requiredPairs: readonly (readonly [string, string])[] },
    traceStateCounts: readonly number[]) {
    const parsed = decodeSemanticDescriptor(descriptor);
    if (traceStateCounts.length < 1 || traceStateCounts.length > 4096 ||
        traceStateCounts.some(n => !Number.isSafeInteger(n) || n < 1)) {
      throw new MatchedEvidenceError("invalid preflight trace state counts");
    }
    this.lengths = Object.freeze([...traceStateCounts]);
    const ids = new Set(parsed.actions.map(action => action.id));
    if (requirements.requiredActions.length > 1024 || requirements.requiredPairs.length > 4096) {
      throw new MatchedEvidenceError("requirements exceed evidence limits");
    }
    for (const id of requirements.requiredActions) {
      if (!ids.has(id) || this.actions.has(id)) throw new MatchedEvidenceError("invalid required action");
      this.actions.set(id, 0);
    }
    const pairKeys = new Set<string>();
    this.pairs = requirements.requiredPairs.map(pair => {
      if (pair.length !== 2 || !ids.has(pair[0]) || !ids.has(pair[1])) throw new MatchedEvidenceError("invalid required pair");
      const key = JSON.stringify(pair);
      if (pairKeys.has(key)) throw new MatchedEvidenceError("duplicate required pair");
      pairKeys.add(key);
      return { from: pair[0], to: pair[1], count: 0 };
    });
    for (const action of [...parsed.initializers, ...parsed.actions]) {
      for (const label of [action.wireAction, ...action.wireAliases]) {
        if (this.labels.has(label)) throw new MatchedEvidenceError("ambiguous action label");
        this.labels.set(label, { id: action.id, initial: action.phase === "initialize" });
      }
    }
  }
  private fail(reason: EvidenceUncertainty, message: string): never {
    this.uncertain.add(reason);
    this.sealed = true;
    throw new MatchedEvidenceError(message);
  }
  private increment(value: number): number {
    if (value === Number.MAX_SAFE_INTEGER) this.fail("counter_overflow", "matched counter overflow");
    return value + 1;
  }
  private requireOpen(): void {
    if (this.sealed) this.fail("protocol", "evidence tracker already sealed");
  }
  private commit(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.currentMatched = this.increment(this.currentMatched);
    if (pending.initial) {
      this.initialMatched = this.increment(this.initialMatched);
      this.previous = undefined;
    } else {
      this.transitionMatched = this.increment(this.transitionMatched);
      const count = this.actions.get(pending.id);
      if (count !== undefined) this.actions.set(pending.id, this.increment(count));
      for (const pair of this.pairs) {
        if (pair.from === this.previous && pair.to === pending.id) pair.count = this.increment(pair.count);
      }
      this.previous = pending.id;
    }
  }
  private finishTrace(): void {
    if (this.started === 0 || this.currentMatched !== this.lengths[this.started - 1]) {
      this.fail("protocol", "trace does not match preflight state count");
    }
    this.completed = this.increment(this.completed);
  }
  begin(initial: boolean, wireAction: string): void {
    this.requireOpen();
    if (this.active) this.fail("protocol", "new action before observation was reported");
    const action = this.labels.get(wireAction);
    if (!action || action.initial !== initial) this.fail("mapping", "unknown or wrong-phase action label");
    // Serial advancement is an implicit acknowledgement in the legacy protocol.
    this.commit();
    if (initial) {
      if (this.started > 0) this.finishTrace();
      if (this.started === this.lengths.length) this.fail("protocol", "extra trace");
      this.started += 1;
      this.currentMatched = 0;
      this.previous = undefined;
    } else if (this.started === 0 || this.currentMatched >= this.lengths[this.started - 1]!) {
      this.fail("protocol", "transition outside preflight trace bounds");
    }
    this.entered = true;
    this.active = action;
  }
  reported(): void {
    this.requireOpen();
    if (!this.active || this.pending) this.fail("protocol", "unexpected report");
    this.reportedCount = this.increment(this.reportedCount);
    this.pending = this.active;
    this.active = undefined;
  }
  acknowledge(): void {
    this.requireOpen();
    if (!this.pending) this.fail("protocol", "acknowledgement without pending observation");
    this.commit();
  }
  done(): void {
    this.requireOpen();
    if (this.active) this.fail("protocol", "terminal before observation report");
    this.commit();
    this.finishTrace();
    if (this.started !== this.lengths.length) this.fail("protocol", "terminal before all selected traces");
    this.complete = true;
    this.sealed = true;
  }
  interrupt(rejected = false): void {
    if (this.sealed) return;
    if (rejected && !this.pending) this.fail("protocol", "rejection without pending observation");
    if (this.pending && !rejected) this.uncertain.add("missing_ack");
    this.pending = undefined;
    this.active = undefined;
    this.sealed = true;
  }
  snapshot(): MatchedEvidence {
    return Object.freeze({
      schema: "mirrorecma.matched-evidence/v1", replayEntered: this.entered,
      corpusCompleted: this.complete, exact: this.uncertain.size === 0,
      tracesSelected: this.lengths.length, tracesStarted: this.started, tracesCompleted: this.completed,
      initialStatesMatched: this.initialMatched, transitionsMatched: this.transitionMatched,
      statesReported: this.reportedCount,
      requiredActionCounts: Object.freeze([...this.actions].map(([id, count]) => Object.freeze({ id, count }))),
      requiredPairCounts: Object.freeze(this.pairs.map(pair => Object.freeze({ ...pair }))),
      uncertainty: Object.freeze(uncertaintyOrder.filter(reason => this.uncertain.has(reason))),
    });
  }
}
