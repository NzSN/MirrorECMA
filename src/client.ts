import { spawnMirror } from "./transport.js";
import {
  MirrorMessage,
  State,
  StateComputer,
  ApalacheConfig,
  ApalacheSpec,
  TraceGenerationConfig,
  TransitionStatus,
  InvariantStatus,
  encodeClientMessage,
  encodeState,
  decodeMirrorMessage,
  prettifyState,
} from "./protocol.js";
import type { Transport } from "./transport.js";
import { readFile } from "node:fs/promises";

export type { State, StateComputer, ApalacheConfig, ApalacheSpec, TraceGenerationConfig, TransitionStatus, InvariantStatus } from "./protocol.js";

export async function specFromFile(path: string): Promise<ApalacheSpec> {
  return { sources: [await readFile(path, "utf8")] };
}

export async function runClientWithTraces(
  binPath: string,
  apalacheConfig: ApalacheConfig,
  tracePaths: string[],
  compute: StateComputer
): Promise<void> {
  const t = spawnMirror(binPath);
  t.send(encodeClientMessage({
    proto_step: "register_traces",
    apalacheConfig,
    itfTracePaths: tracePaths,
  }));
  await mainLoop(t, compute);
}

export async function runClient(
  binPath: string,
  apalacheConfig: ApalacheConfig,
  config: TraceGenerationConfig,
  compute: StateComputer
): Promise<void> {
  const t = spawnMirror(binPath);
  t.send(encodeClientMessage({
    proto_step: "register",
    apalacheConfig,
    traceConfig: config,
  }));
  await mainLoop(t, compute);
}

export async function runClientGenTraces(
  binPath: string,
  apalacheConfig: ApalacheConfig,
  destPath: string,
  config: TraceGenerationConfig
): Promise<void> {
  const t = spawnMirror(binPath);
  t.send(encodeClientMessage({
    proto_step: "register_trace_gen",
    apalacheConfig,
    traceConfig: config,
    destPath,
  }));
  await genTracesLoop(t);
}

export async function runClientExplore(
  binPath: string,
  spec: ApalacheSpec,
  invariants: string[],
  exports: string[],
  maxSteps: number,
  compute: StateComputer
): Promise<void> {
  const t = spawnMirror(binPath);
  t.send(encodeClientMessage({
    proto_step: "register_explore",
    spec,
    invariants,
    exports,
    maxSteps,
  }));
  await mainLoop(t, compute);
}

export class ExploreSession {
  private constructor(
    private t: Transport,
    private it: AsyncIterator<string>,
    public readonly ready: {
      initTransitions: number;
      nextTransitions: number;
      stateInvariants: number;
    }
  ) {}

  static async open(
    binPath: string,
    spec: ApalacheSpec,
    invariants: string[],
    exports: string[]
  ): Promise<ExploreSession> {
    const t = spawnMirror(binPath);
    const it = t[Symbol.asyncIterator]();
    t.send(encodeClientMessage({
      proto_step: "register_explore_session",
      spec,
      invariants,
      exports,
    }));
    const msg = await recv(it);
    if (msg.proto_step === "register_error") { await t.close(); throw new Error(`register failed: ${msg.error}`); }
    if (msg.proto_step === "protocol_error") { await t.close(); throw new Error(msg.error); }
    if (msg.proto_step !== "explorer_ready") {
      await t.close();
      throw new Error(`expected explorer_ready, got ${msg.proto_step}`);
    }
    return new ExploreSession(t, it, {
      initTransitions: msg.initTransitions,
      nextTransitions: msg.nextTransitions,
      stateInvariants: msg.stateInvariants,
    });
  }

  async assumeTransition(transitionId: number): Promise<TransitionStatus> {
    const msg = await this.cmd({ proto_step: "explore_assume_transition", transitionId });
    if (msg.proto_step !== "explore_transition_status")
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    return msg.status;
  }

  async nextStep(): Promise<number> {
    const msg = await this.cmd({ proto_step: "explore_next_step" });
    if (msg.proto_step !== "explore_step_done")
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    return msg.stepNo;
  }

  async queryState(): Promise<State> {
    const msg = await this.cmd({ proto_step: "explore_query_state" });
    if (msg.proto_step !== "explore_state")
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    return msg.state;
  }

  async checkInvariant(invariantId: number): Promise<InvariantStatus> {
    const msg = await this.cmd({ proto_step: "explore_check_invariant", invariantId });
    if (msg.proto_step !== "explore_invariant_status")
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    return msg.status;
  }

  async assumeState(eqs: State): Promise<TransitionStatus> {
    this.t.send(JSON.stringify({ proto_step: "explore_assume_state", state: encodeState(eqs) }));
    const msg = await recv(this.it);
    if (msg.proto_step === "protocol_error") throw new Error(msg.error);
    if (msg.proto_step !== "explore_assume_status")
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    return msg.status;
  }

  async rollback(snapshotId: number): Promise<number> {
    const msg = await this.cmd({ proto_step: "explore_rollback", snapshotId });
    if (msg.proto_step !== "explore_rollback_done")
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    return msg.snapshotId;
  }

  async done(): Promise<void> {
    const msg = await this.cmd({ proto_step: "explore_done" });
    if (msg.proto_step !== "explore_session_done")
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    await this.t.close();
  }

  private async cmd(m: Parameters<typeof encodeClientMessage>[0]): Promise<MirrorMessage> {
    this.t.send(encodeClientMessage(m));
    const msg = await recv(this.it);
    if (msg.proto_step === "protocol_error") throw new Error(msg.error);
    return msg;
  }
}

export function startExploreSession(
  binPath: string,
  spec: ApalacheSpec,
  invariants: string[],
  exports: string[]
): Promise<ExploreSession> {
  return ExploreSession.open(binPath, spec, invariants, exports);
}

async function mainLoop(t: Transport, compute: StateComputer): Promise<void> {
  const it = t[Symbol.asyncIterator]();

  const msg0 = await recv(it);
  if (msg0.proto_step === "protocol_error") { await t.close(); throw new Error(msg0.error); }
  if (msg0.proto_step === "register_error") { await t.close(); throw new Error(`register failed: ${msg0.error}`); }
  if (msg0.proto_step !== "spec_validated") {
    await t.close();
    throw new Error(`expected spec_validated, got ${msg0.proto_step}`);
  }
  if (typeof msg0.result !== "string") {
    await t.close();
    throw new Error(`spec invalid: ${msg0.result.invalid}`);
  }

  let msg = await recv(it);
  let state: State = {};
  let lastParam: State = {}
  let lastAction = "";
  for (;;) {
    switch (msg.proto_step) {
      case "initial_state":
        lastAction = msg.action;
        state = compute(msg.action, msg.state, {});
        t.send(JSON.stringify({ proto_step: "report_state", state: encodeState(state) }));
        break;
      case "step_ok":
        break;
      case "all_steps_done":
        await t.close();
        return;
      case "next_step":
        lastAction = msg.action;
        state = compute(msg.action, msg.parameters, state);
        lastParam = msg.parameters;
        t.send(JSON.stringify({ proto_step: "report_state", state: encodeState(state) }));
        break;
      case "step_mismatch":
        await t.close();
        throw new Error(
            `step mismatch on action "${msg.action ?? lastAction}" with param "${lastParam}": expected ${JSON.stringify(prettifyState(msg.expected))}, got ${JSON.stringify(prettifyState(msg.actual))}`
        );
      case "protocol_error":
        await t.close();
        throw new Error(msg.error);
      case "register_error":
        await t.close();
        throw new Error(`register failed: ${msg.error}`);
      default:
        await t.close();
        throw new Error(`unexpected message: ${msg.proto_step}`);
    }
    msg = await recv(it);
  }
}

export function presetClient(states: State[]): StateComputer {
  let i = 0;
  return () => {
    if (i >= states.length) throw new Error("presetClient exhausted");
    return states[i++]!;
  };
}

async function recv(it: AsyncIterator<string>): Promise<MirrorMessage> {
  const { value, done } = await it.next();
  if (done) throw new Error("transport closed unexpectedly");
  return decodeMirrorMessage(value);
}

async function genTracesLoop(t: Transport): Promise<void> {
  const it = t[Symbol.asyncIterator]();

  const msg = await recv(it);
  if (msg.proto_step === "protocol_error") { await t.close(); throw new Error(msg.error); }
  if (msg.proto_step === "register_error") { await t.close(); throw new Error(`register failed: ${msg.error}`); }
  if (msg.proto_step === "gen_traces_done") { await t.close(); return; }
  await t.close();
  throw new Error(`expected gen_traces_done, got ${msg.proto_step}`);
}
