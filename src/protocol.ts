// Itftraces file format specifications:
// https://apalache-mc.org/docs/adr/015adr-trace.html#summary

// Mirrors the Haskell Apalache.Types.Value
export type Value =
  | { tag: "int"; val: bigint }
  | { tag: "bool"; val: boolean }
  | { tag: "str"; val: string }
  | { tag: "set"; val: Value[] }
  | { tag: "seq"; val: Value[] }
  | { tag: "tuple"; val: Value[] }
  | { tag: "map"; val: [Value, Value][] }
  | { tag: "record"; val: Record<string, Value> }
  | { tag: "variant"; variantTag: string; value: Value }
  | { tag: "unserializable"; val: string }
  | { tag: "null" };

export type State = Record<string, Value>;

export type StateComputer = (
  action: string,
  params: State,
  prevState: State
) => State;

// ---- Message types ----

export interface ApalacheSpec {
  sources: string[];
}

export type TransitionStatus = "ENABLED" | "DISABLED" | "UNKNOWN";
export type InvariantStatus = "SATISFIED" | "VIOLATED" | "UNKNOWN";

export type ClientMessage =
  | Register
  | RegisterTraces
  | RegisterTraceGen
  | RegisterExplore
  | RegisterExploreSession
  | ExploreAssumeTransition
  | ExploreNextStep
  | ExploreQueryState
  | ExploreCheckInvariant
  | ExploreAssumeState
  | ExploreRollback
  | ExploreDone
  | ReportState;

export type MirrorMessage =
  | SpecValidated
  | InitialState
  | NextStep
  | StepOk
  | StepMismatch
  | AllStepsDone
  | GenTracesDone
  | ProtocolError
  | RegisterError
  | ExplorerReady
  | ExploreTransitionStatus
  | ExploreStepDone
  | ExploreState
  | ExploreInvariantStatus
  | ExploreAssumeStatus
  | ExploreRollbackDone
  | ExploreSessionDone;

export interface ApalacheConfig {
  specPath: string;
  initPredicate?: string | null;
  nextPredicate?: string | null;
  constInit?: string | null;
  invariant: string;
  lengthBound: number;
  paramVars?: string;
}

export interface TraceGenerationConfig {
  numTraces: number;
  view?: string;
}

export interface Register {
  proto_step: "register";
  apalacheConfig: ApalacheConfig;
  traceConfig: TraceGenerationConfig;
  spec?: ApalacheSpec;
}

export interface RegisterTraces {
  proto_step: "register_traces";
  apalacheConfig: ApalacheConfig;
  itfTracePaths: string[];
}

export interface RegisterTraceGen {
  proto_step: "register_trace_gen";
  apalacheConfig: ApalacheConfig;
  traceConfig: TraceGenerationConfig;
  destPath: string;
  spec?: ApalacheSpec;
}

export interface RegisterExplore {
  proto_step: "register_explore";
  spec: ApalacheSpec;
  invariants: string[];
  exports: string[];
  maxSteps: number;
}

export interface RegisterExploreSession {
  proto_step: "register_explore_session";
  spec: ApalacheSpec;
  invariants: string[];
  exports: string[];
}

export interface ExploreAssumeTransition {
  proto_step: "explore_assume_transition";
  transitionId: number;
}

export interface ExploreNextStep {
  proto_step: "explore_next_step";
}

export interface ExploreQueryState {
  proto_step: "explore_query_state";
}

export interface ExploreCheckInvariant {
  proto_step: "explore_check_invariant";
  invariantId: number;
}

export interface ExploreAssumeState {
  proto_step: "explore_assume_state";
  state: State;
}

export interface ExploreRollback {
  proto_step: "explore_rollback";
  snapshotId: number;
}

export interface ExploreDone {
  proto_step: "explore_done";
}

export interface ReportState {
  proto_step: "report_state";
  state: State;
}

export interface SpecValidated {
  proto_step: "spec_validated";
  result: "valid" | { invalid: string };
}

export interface InitialState {
  proto_step: "initial_state";
  action: string;
  state: State;
}

export interface NextStep {
  proto_step: "next_step";
  action: string;
  parameters: State;
}

export interface StepOk {
  proto_step: "step_ok";
}

export interface StepMismatch {
  proto_step: "step_mismatch";
  action?: string;
  expected: State;
  actual: State;
  hints?: DiffHint[];
}

// ---- Diff hints (path-based mismatch explanation) ----

export type PathSeg = { field: string } | { index: number };

export type DiffHint =
  | { kind: "value_mismatch"; path: PathSeg[]; expected: Value; actual: Value }
  | { kind: "missing"; path: PathSeg[]; expected: Value }
  | { kind: "extra"; path: PathSeg[]; actual: Value }
  | { kind: "type_mismatch"; path: PathSeg[]; expected: Value; actual: Value }
  | { kind: "truncated"; path: PathSeg[] };

export interface AllStepsDone {
  proto_step: "all_steps_done";
}

export interface GenTracesDone {
  proto_step: "gen_traces_done";
  itfTracePaths: string[];
}

export interface ProtocolError {
  proto_step: "protocol_error";
  error: string;
}

export interface RegisterError {
  proto_step: "register_error";
  error: string;
}

export interface ExplorerReady {
  proto_step: "explorer_ready";
  initTransitions: number;
  nextTransitions: number;
  stateInvariants: number;
}

export interface ExploreTransitionStatus {
  proto_step: "explore_transition_status";
  status: TransitionStatus;
}

export interface ExploreStepDone {
  proto_step: "explore_step_done";
  stepNo: number;
}

export interface ExploreState {
  proto_step: "explore_state";
  state: State;
}

export interface ExploreInvariantStatus {
  proto_step: "explore_invariant_status";
  status: InvariantStatus;
}

export interface ExploreAssumeStatus {
  proto_step: "explore_assume_status";
  status: TransitionStatus;
}

export interface ExploreRollbackDone {
  proto_step: "explore_rollback_done";
  snapshotId: number;
}

export interface ExploreSessionDone {
  proto_step: "explore_session_done";
}

// ---- JSON encode/decode ----

export function encodeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg, (_key, v) =>
    typeof v === "bigint" ? { "#bigint": String(v) } : v
  );
}

export function encodeState(state: State): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    out[k] = encodeValue(v);
  }
  return out;
}

function encodeValue(v: Value): unknown {
  switch (v.tag) {
    case "int":  return { "#bigint": String(v.val) };
    case "bool": return v.val;
    case "str":  return v.val;
    case "set":   return { "#set": v.val.map(encodeValue) };
    case "seq":   return v.val.map(encodeValue);
    case "tuple": return { "#tup": v.val.map(encodeValue) };
    case "map":   return { "#map": v.val.map(([k, iv]) => [encodeValue(k), encodeValue(iv)]) };
    case "record": {
      const rec: Record<string, unknown> = {};
      for (const [k, iv] of Object.entries(v.val))
        rec[k] = encodeValue(iv);
      return rec;
    }
    case "variant": return { tag: v.variantTag, value: encodeValue(v.value) };
    case "unserializable": return { "#unserializable": v.val };
    case "null": return null;
  }
}

export function decodeMirrorMessage(line: string): MirrorMessage {
  const raw = JSON.parse(line);
  const msg = walk(raw);
  switch (msg.proto_step) {
    case "spec_validated":
    case "initial_state":
    case "next_step":
    case "step_ok":
    case "step_mismatch":
    case "all_steps_done":
    case "gen_traces_done":
    case "protocol_error":
    case "register_error":
    case "explorer_ready":
    case "explore_transition_status":
    case "explore_step_done":
    case "explore_state":
    case "explore_invariant_status":
    case "explore_assume_status":
    case "explore_rollback_done":
    case "explore_session_done":
      return msg;
    default:
      return { proto_step: "protocol_error", error: `unknown step: ${(msg as any).proto_step}` };
  }
}

function walk(v: unknown): any {
  if (v === null) return { tag: "null" };
  if (typeof v === "boolean") return { tag: "bool", val: v };
  if (typeof v === "string") return { tag: "str", val: v };
  if (typeof v === "number") return { tag: "int", val: BigInt(v) };
  if (Array.isArray(v)) return { tag: "seq", val: v.map(walk) };
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("#bigint" in obj && typeof obj["#bigint"] === "string")
      return { tag: "int", val: BigInt(obj["#bigint"] as string) };
    if ("#tup" in obj && Array.isArray(obj["#tup"]))
      return { tag: "tuple", val: (obj["#tup"] as unknown[]).map(walk) };
    if ("#set" in obj && Array.isArray(obj["#set"]))
      return { tag: "set", val: (obj["#set"] as unknown[]).map(walk) };
    if ("#map" in obj && Array.isArray(obj["#map"]))
      return {
        tag: "map",
        val: (obj["#map"] as unknown[][]).map(([k, v]) => [walk(k), walk(v)]),
      };
    if ("#unserializable" in obj && typeof obj["#unserializable"] === "string")
      return { tag: "unserializable", val: obj["#unserializable"] as string };
    if ("proto_step" in obj)
      return walkMessage(obj);
    if ("tag" in obj && "value" in obj && typeof obj.tag === "string")
      return { tag: "variant", variantTag: obj.tag as string, value: walk(obj.value) };
    const rec: Record<string, Value> = {};
    for (const [k, val] of Object.entries(obj))
      rec[k] = walk(val) as Value;
    return { tag: "record", val: rec };
  }
  return { tag: "null" };
}

function walkMessage(obj: Record<string, unknown>): MirrorMessage {
  const step = obj.proto_step as string;
  switch (step) {
    case "spec_validated": {
      const result = obj.result;
      if (typeof result === "string") return { proto_step: "spec_validated", result: result as "valid" };
      return { proto_step: "spec_validated", result: { invalid: JSON.stringify(result) } };
    }
    case "initial_state":
      return {
        proto_step: "initial_state",
        action: obj.action as string,
        state: (walk(obj.state) as { tag: "record"; val: Record<string, Value> }).val,
      };
    case "next_step":
      return {
        proto_step: "next_step",
        action: obj.action as string,
        parameters: (walk(obj.parameters) as { tag: "record"; val: Record<string, Value> }).val,
      };
    case "step_ok":
      return { proto_step: "step_ok" };
    case "step_mismatch":
      return {
        proto_step: "step_mismatch",
        action: obj.action as string | undefined,
        expected: (walk(obj.expected) as { tag: "record"; val: Record<string, Value> }).val,
        actual: (walk(obj.actual) as { tag: "record"; val: Record<string, Value> }).val,
        hints: decodeHints(obj.hints),
      };
    case "all_steps_done":
      return { proto_step: "all_steps_done" };
    case "gen_traces_done":
      return {
        proto_step: "gen_traces_done",
        itfTracePaths: (obj.itfTracePaths as string[]) ?? [],
      };
    case "protocol_error":
      return { proto_step: "protocol_error", error: obj.error as string };
    case "register_error":
      return { proto_step: "register_error", error: obj.error as string };
    case "explorer_ready":
      return {
        proto_step: "explorer_ready",
        initTransitions: obj.initTransitions as number,
        nextTransitions: obj.nextTransitions as number,
        stateInvariants: obj.stateInvariants as number,
      };
    case "explore_transition_status":
      return { proto_step: "explore_transition_status", status: obj.status as TransitionStatus };
    case "explore_step_done":
      return { proto_step: "explore_step_done", stepNo: obj.stepNo as number };
    case "explore_state":
      return {
        proto_step: "explore_state",
        state: (walk(obj.state) as { tag: "record"; val: Record<string, Value> }).val,
      };
    case "explore_invariant_status":
      return { proto_step: "explore_invariant_status", status: obj.status as InvariantStatus };
    case "explore_assume_status":
      return { proto_step: "explore_assume_status", status: obj.status as TransitionStatus };
    case "explore_rollback_done":
      return { proto_step: "explore_rollback_done", snapshotId: obj.snapshotId as number };
    case "explore_session_done":
      return { proto_step: "explore_session_done" };
    default:
      return { proto_step: "protocol_error", error: `unknown proto_step: ${step}` };
  }
}

function decodeHints(raw: unknown): DiffHint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((h): DiffHint => {
    const o = h as Record<string, unknown>;
    const path = ((o.path as unknown[]) ?? []).map((seg): PathSeg => {
      const s = seg as Record<string, unknown>;
      if (typeof s.field === "string") return { field: s.field };
      return { index: s.index as number };
    });
    switch (o.kind as string) {
      case "value_mismatch":
        return { kind: "value_mismatch", path, expected: walk(o.expected) as Value, actual: walk(o.actual) as Value };
      case "missing":
        return { kind: "missing", path, expected: walk(o.expected) as Value };
      case "extra":
        return { kind: "extra", path, actual: walk(o.actual) as Value };
      case "type_mismatch":
        return { kind: "type_mismatch", path, expected: walk(o.expected) as Value, actual: walk(o.actual) as Value };
      default:
        return { kind: "truncated", path };
    }
  });
}

export function renderPath(path: PathSeg[]): string {
  const s = path
    .map((seg) => ("field" in seg ? `.${seg.field}` : `[${seg.index}]`))
    .join("");
  return s.startsWith(".") ? s.slice(1) : s || "<state>";
}

function renderHintValue(v: Value): string {
  return JSON.stringify(prettifyValue(v));
}

export function renderDiffHint(h: DiffHint): string {
  const at = `at ${renderPath(h.path)}`;
  switch (h.kind) {
    case "value_mismatch":
      return `${at}: expected ${renderHintValue(h.expected)}, got ${renderHintValue(h.actual)}`;
    case "missing":
      return `${at}: missing ${renderHintValue(h.expected)}`;
    case "extra":
      return `${at}: unexpected ${renderHintValue(h.actual)}`;
    case "type_mismatch":
      return `${at}: expected a value of shape ${renderHintValue(h.expected)}, got ${renderHintValue(h.actual)}`;
    case "truncated":
      return `${at}: further differences truncated`;
  }
}

export function renderDiffHints(hints: DiffHint[]): string {
  if (hints.length === 0) return "states differ";
  return hints.map(renderDiffHint).join("; ");
}

// Helpers to extract values from the deeply-nested representation

export function asInt(v: Value): bigint | null {
  return v.tag === "int" ? v.val : null;
}

export function asStr(v: Value): string | null {
  return v.tag === "str" ? v.val : null;
}

export function asRecord(v: Value): Record<string, Value> | null {
  return v.tag === "record" ? v.val : null;
}

// ---- Helpers for parameter extraction ----

export function getParam(params: State, varName: string): Record<string, Value> | null {
  const v = params[varName];
  return v && v.tag === "record" ? v.val : null;
}

export function getParamInt(params: State, varName: string, field: string): number {
  const rec = getParam(params, varName);
  if (!rec) return 0;
  const v = rec[field];
  return v && v.tag === "int" ? Number(v.val) : 0;
}

// ---- Prettify for error messages ----

export function prettifyState(state: State): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    out[k] = prettifyValue(v);
  }
  return out;
}

function prettifyValue(v: Value): unknown {
  switch (v.tag) {
    case "int": return Number(v.val);
    case "bool": return v.val;
    case "str": return v.val;
    case "set": return v.val.map(prettifyValue);
    case "seq": return v.val.map(prettifyValue);
    case "tuple": return v.val.map(prettifyValue);
    case "map": return v.val.map(([k, iv]) => [prettifyValue(k), prettifyValue(iv)]);
    case "record": {
      const rec: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.val)) {
        rec[k] = prettifyValue(val);
      }
      return rec;
    }
    case "variant": return { tag: v.variantTag, value: prettifyValue(v.value) };
    case "unserializable": return v.val;
    case "null": return null;
  }
}
