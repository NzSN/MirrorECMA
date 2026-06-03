// Mirrors the Haskell Apalache.Types.Value
export type Value =
  | { tag: "int"; val: bigint }
  | { tag: "bool"; val: boolean }
  | { tag: "str"; val: string }
  | { tag: "set"; val: Value[] }
  | { tag: "tuple"; val: Value[] }
  | { tag: "record"; val: Record<string, Value> }
  | { tag: "null" };

export type State = Record<string, Value>;

export type StateComputer = (
  action: string,
  params: State,
  prevState: State
) => State;

// ---- Message types ----

export type ClientMessage = Register | ReportState;

export type MirrorMessage =
  | SpecValidated
  | InitialState
  | NextStep
  | StepOk
  | StepMismatch
  | AllStepsDone
  | ProtocolError;

export interface Register {
  proto_step: "register";
  specPath: string;
  traceConfig: TraceGenerationConfig;
}

export interface TraceGenerationConfig {
  invariant: string;
  lengthBound: number;
  numTraces: number;
  cinit?: string | null;
  paramVars?: string;
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
}

export interface AllStepsDone {
  proto_step: "all_steps_done";
}

export interface ProtocolError {
  proto_step: "protocol_error";
  error: string;
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
    case "set":  return v.val.map(encodeValue);
    case "tuple": return { "#tup": v.val.map(encodeValue) };
    case "record": {
      const rec: Record<string, unknown> = {};
      for (const [k, iv] of Object.entries(v.val))
        rec[k] = encodeValue(iv);
      return rec;
    }
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
    case "protocol_error":
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
  if (Array.isArray(v)) return { tag: "set", val: v.map(walk) };
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("#bigint" in obj && typeof obj["#bigint"] === "string")
      return { tag: "int", val: BigInt(obj["#bigint"] as string) };
    if ("#tup" in obj && Array.isArray(obj["#tup"]))
      return { tag: "tuple", val: (obj["#tup"] as unknown[]).map(walk) };
    if ("proto_step" in obj)
      return walkMessage(obj);
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
      };
    case "all_steps_done":
      return { proto_step: "all_steps_done" };
    case "protocol_error":
      return { proto_step: "protocol_error", error: obj.error as string };
    default:
      return { proto_step: "protocol_error", error: `unknown proto_step: ${step}` };
  }
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
    case "tuple": return v.val.map(prettifyValue);
    case "record": {
      const rec: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.val)) {
        rec[k] = prettifyValue(val);
      }
      return rec;
    }
    case "null": return null;
  }
}
