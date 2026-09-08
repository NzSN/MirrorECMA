import {
  decodeMirrorMessage,
  encodeState,
  prettifyState,
  renderDiffHints,
  type MirrorMessage,
  type State,
  type StateComputer,
} from "./protocol.js";
import type { Transport } from "./transport.js";
import {
  invokeAsyncComputer,
  throwIfReplayCancelled,
  type AsyncStateComputer,
} from "./async-replay.js";
import { ReplayMismatchError, replayReport, type ReplayReport } from "./replay-report.js";

export type ReplayStepResult =
  | { readonly kind: "ready"; readonly state: State }
  | { readonly kind: "pending"; readonly state: Promise<State> };

export interface ReplayExecutionAdapter {
  start(action: string, payload: State, previous: State): ReplayStepResult;
}

/** Receive one complete JSONL payload without interpreting additive fields. */
export async function receiveLine(it: AsyncIterator<string>): Promise<string> {
  const { value, done } = await it.next();
  if (done) throw new Error("transport closed unexpectedly");
  return value;
}

/** Decode one ordinary Mirrors message with the legacy diagnostic text. */
export function decodeReplayMessage(line: string): MirrorMessage {
  try {
    return decodeMirrorMessage(line);
  } catch (err) {
    const snippet = line.length > 200 ? `${line.slice(0, 200)}…` : line;
    throw new Error(`failed to decode mirror message: ${snippet}`, { cause: err });
  }
}

export async function receiveReplayMessage(
  it: AsyncIterator<string>,
): Promise<MirrorMessage> {
  return decodeReplayMessage(await receiveLine(it));
}

/** Validate the existing registration barrier before any StateComputer call. */
export function requireValidRegistration(message: MirrorMessage): void {
  if (message.proto_step === "protocol_error") throw new Error(message.error);
  if (message.proto_step === "register_error") throw new Error(`register failed: ${message.error}`);
  if (message.proto_step !== "spec_validated") {
    throw new Error(`expected spec_validated, got ${message.proto_step}`);
  }
  if (typeof message.result !== "string") throw new Error(`spec invalid: ${message.result.invalid}`);
}

export function synchronousReplayExecution(compute: StateComputer): ReplayExecutionAdapter {
  return {
    start: (action, payload, previous) => ({
      kind: "ready",
      // Keep the compute call in this expression. The caller encodes this
      // result before reaching another await, preserving legacy timing.
      state: compute(action, payload, previous),
    }),
  };
}

export function asynchronousReplayExecution(
  compute: AsyncStateComputer,
  signal: AbortSignal | undefined,
  stepMs: number,
): ReplayExecutionAdapter {
  return {
    start: (action, payload, previous) => ({
      kind: "pending",
      state: invokeAsyncComputer(compute, { action, payload, previous }, signal, stepMs),
    }),
  };
}

export interface ReplayCoreOptions {
  readonly structuredMismatch?: boolean;
  readonly signal?: AbortSignal;
  readonly receive?: () => ReturnType<typeof receiveReplayMessage>;
}

/** One transition state machine shared by synchronous and asynchronous runners. */
export async function replayCore(
  t: Transport,
  it: AsyncIterator<string>,
  execution: ReplayExecutionAdapter,
  options: ReplayCoreOptions = {},
): Promise<ReplayReport> {
  const receive = options.receive ?? (() => receiveReplayMessage(it));
  let msg = await receive();
  let state: State = {};
  let lastParam: State = {};
  let lastAction = "";
  let traceIndex = -1;
  let stepIndex = 0;
  let acceptedTraces = 0;
  let acceptedSteps = 0;
  for (;;) {
    throwIfReplayCancelled(options.signal);
    switch (msg.proto_step) {
      case "initial_state": {
        lastAction = msg.action;
        traceIndex += 1;
        stepIndex = 0;
        const result = execution.start(msg.action, msg.state, {});
        if (result.kind === "ready") {
          state = result.state;
          t.send(JSON.stringify({ proto_step: "report_state", state: encodeState(state) }));
        } else {
          state = await result.state;
          throwIfReplayCancelled(options.signal);
          t.send(JSON.stringify({ proto_step: "report_state", state: encodeState(state) }));
        }
        acceptedTraces += 1;
        break;
      }
      case "step_ok":
        break;
      case "all_steps_done":
        return replayReport(acceptedTraces, acceptedSteps);
      case "next_step": {
        lastAction = msg.action;
        stepIndex += 1;
        const result = execution.start(msg.action, msg.parameters, state);
        lastParam = msg.parameters;
        if (result.kind === "ready") {
          state = result.state;
          t.send(JSON.stringify({ proto_step: "report_state", state: encodeState(state) }));
        } else {
          state = await result.state;
          throwIfReplayCancelled(options.signal);
          t.send(JSON.stringify({ proto_step: "report_state", state: encodeState(state) }));
        }
        acceptedSteps += 1;
        break;
      }
      case "step_mismatch": {
        const action = msg.action ?? lastAction;
        const hintText = msg.hints?.length
          ? `: ${renderDiffHints(msg.hints)}`
          : `: expected ${JSON.stringify(prettifyState(msg.expected))}, got ${JSON.stringify(prettifyState(msg.actual))}`;
        const text = `step mismatch on action "${action}" with param "${lastParam}"${hintText}`;
        if (options.structuredMismatch) {
          throw new ReplayMismatchError(
            text,
            msg.expected,
            msg.actual,
            Object.freeze([...(msg.hints ?? [])]),
            Math.max(traceIndex, 0),
            stepIndex,
            action,
          );
        }
        throw new Error(text);
      }
      case "protocol_error":
        throw new Error(msg.error);
      case "register_error":
        throw new Error(`register failed: ${msg.error}`);
      default:
        throw new Error(`unexpected message: ${msg.proto_step}`);
    }
    msg = await receive();
  }
}
