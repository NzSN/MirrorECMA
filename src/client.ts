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
  renderDiffHints,
} from "./protocol.js";
import type { Transport } from "./transport.js";
import { readFile } from "node:fs/promises";

export type { State, StateComputer, ApalacheConfig, ApalacheSpec, TraceGenerationConfig, TransitionStatus, InvariantStatus } from "./protocol.js";

export interface RunOptions {
  /** Inline spec sources (root module first); when present, the mirror
   *  materializes them and ignores apalacheConfig.specPath. Use
   *  specFromFiles to build this from a root .tla file. */
  spec?: ApalacheSpec;
}

export async function specFromFile(path: string): Promise<ApalacheSpec> {
  return { sources: [await readFile(path, "utf8")] };
}

export async function runClientWithTraces(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  tracePaths: string[],
  compute: StateComputer
): Promise<void> {
  const t = await resolveTransport(target);
  t.send(encodeClientMessage({
    proto_step: "register_traces",
    apalacheConfig,
    itfTracePaths: tracePaths,
  }));
  await mainLoop(t, compute);
}

export async function runClient(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  config: TraceGenerationConfig,
  compute: StateComputer,
  opts: RunOptions = {}
): Promise<void> {
  const t = await resolveTransport(target);
  t.send(encodeClientMessage({
    proto_step: "register",
    apalacheConfig,
    traceConfig: config,
    spec: opts.spec,
  }));
  await mainLoop(t, compute);
}

export interface GenTracesResult {
  /** Server-local paths of the generated trace files (usable only when the
   *  mirror shares the filesystem, e.g. stdio mode). */
  itfTracePaths: string[];
  /** Inline ITF JSON trace contents, one per path; usable in any transport
   *  mode. Empty when the mirror predates trace inlining. */
  itfTraces: unknown[];
}

export async function runClientGenTraces(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  destPath: string | null,
  config: TraceGenerationConfig,
  opts: RunOptions = {}
): Promise<GenTracesResult> {
  const t = await resolveTransport(target);
  t.send(encodeClientMessage({
    proto_step: "register_trace_gen",
    apalacheConfig,
    traceConfig: config,
    destPath,
    spec: opts.spec,
  }));
  return genTracesLoop(t);
}

export async function runClientExplore(
  target: string | Transport,
  spec: ApalacheSpec,
  invariants: string[],
  exports: string[],
  maxSteps: number,
  compute: StateComputer
): Promise<void> {
  const t = await resolveTransport(target);
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
  /** Set once the session is over (done, abort, or a fatal exchange
   *  error); every method rejects afterwards. */
  private closed = false;

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
    target: string | Transport,
    spec: ApalacheSpec,
    invariants: string[],
    exports: string[]
  ): Promise<ExploreSession> {
    const t = await resolveTransport(target);
    const it = t[Symbol.asyncIterator]();
    try {
      t.send(encodeClientMessage({
        proto_step: "register_explore_session",
        spec,
        invariants,
        exports,
      }));
      const msg = await recv(it);
      if (msg.proto_step === "register_error") throw new Error(`register failed: ${msg.error}`);
      if (msg.proto_step === "protocol_error") throw new Error(msg.error);
      if (msg.proto_step !== "explorer_ready") {
        throw new Error(`expected explorer_ready, got ${msg.proto_step}`);
      }
      return new ExploreSession(t, it, {
        initTransitions: msg.initTransitions,
        nextTransitions: msg.nextTransitions,
        stateInvariants: msg.stateInvariants,
      });
    } catch (err) {
      // Never leak the transport when the handshake fails.
      await t.close();
      throw err;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("explore session is closed");
  }

  /** Mark closed and close the transport without the explore_done
   *  handshake (fatal exchange errors). Idempotent. */
  private async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.t.close();
  }

  async assumeTransition(transitionId: number): Promise<TransitionStatus> {
    const msg = await this.cmd({ proto_step: "explore_assume_transition", transitionId });
    if (msg.proto_step !== "explore_transition_status") {
      await this.abort();
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    }
    return msg.status;
  }

  async nextStep(): Promise<number> {
    const msg = await this.cmd({ proto_step: "explore_next_step" });
    if (msg.proto_step !== "explore_step_done") {
      await this.abort();
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    }
    return msg.stepNo;
  }

  async queryState(): Promise<State> {
    const msg = await this.cmd({ proto_step: "explore_query_state" });
    if (msg.proto_step !== "explore_state") {
      await this.abort();
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    }
    return msg.state;
  }

  async checkInvariant(invariantId: number): Promise<InvariantStatus> {
    const msg = await this.cmd({ proto_step: "explore_check_invariant", invariantId });
    if (msg.proto_step !== "explore_invariant_status") {
      await this.abort();
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    }
    return msg.status;
  }

  async assumeState(eqs: State): Promise<TransitionStatus> {
    this.assertOpen();
    this.t.send(JSON.stringify({ proto_step: "explore_assume_state", state: encodeState(eqs) }));
    let msg: MirrorMessage;
    try {
      msg = await recv(this.it);
    } catch (err) {
      await this.abort();
      throw err;
    }
    if (msg.proto_step === "protocol_error") {
      await this.abort();
      throw new Error(msg.error);
    }
    if (msg.proto_step !== "explore_assume_status") {
      await this.abort();
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    }
    return msg.status;
  }

  async rollback(snapshotId: number): Promise<number> {
    const msg = await this.cmd({ proto_step: "explore_rollback", snapshotId });
    if (msg.proto_step !== "explore_rollback_done") {
      await this.abort();
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    }
    return msg.snapshotId;
  }

  /** End the session with the explore_done handshake and close the
   *  transport. Idempotent: calling done() twice is a no-op. */
  async done(): Promise<void> {
    if (this.closed) return;
    const msg = await this.cmd({ proto_step: "explore_done" });
    if (msg.proto_step !== "explore_session_done") {
      await this.abort();
      throw new Error(`unexpected reply: ${msg.proto_step}`);
    }
    this.closed = true;
    await this.t.close();
  }

  private async cmd(m: Parameters<typeof encodeClientMessage>[0]): Promise<MirrorMessage> {
    this.assertOpen();
    this.t.send(encodeClientMessage(m));
    let msg: MirrorMessage;
    try {
      msg = await recv(this.it);
    } catch (err) {
      await this.abort();
      throw err;
    }
    if (msg.proto_step === "protocol_error") {
      await this.abort();
      throw new Error(msg.error);
    }
    return msg;
  }
}

export function startExploreSession(
  target: string | Transport,
  spec: ApalacheSpec,
  invariants: string[],
  exports: string[]
): Promise<ExploreSession> {
  return ExploreSession.open(target, spec, invariants, exports);
}

type MaybeReadyTransport = Transport & { ready?: Promise<void> };

async function resolveTransport(target: string | Transport): Promise<Transport> {
  const t = typeof target === "string" ? spawnMirror(target) : target;
  const maybeReady = t as MaybeReadyTransport;
  if (maybeReady.ready) await maybeReady.ready;
  return t;
}

async function mainLoop(t: Transport, compute: StateComputer): Promise<void> {
  const it = t[Symbol.asyncIterator]();
  // C8 hardening: any exit — terminal message, mirror error, decode
  // failure, or a throwing StateComputer — closes the transport exactly
  // once, so a client-side failure never wedges the session (parking a
  // worker on the pool server).
  let closed = false;
  const closeOnce = async () => {
    if (!closed) {
      closed = true;
      await t.close();
    }
  };
  try {
    const msg0 = await recv(it);
    if (msg0.proto_step === "protocol_error") throw new Error(msg0.error);
    if (msg0.proto_step === "register_error") throw new Error(`register failed: ${msg0.error}`);
    if (msg0.proto_step !== "spec_validated") {
      throw new Error(`expected spec_validated, got ${msg0.proto_step}`);
    }
    if (typeof msg0.result !== "string") {
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
          return;
        case "next_step":
          lastAction = msg.action;
          state = compute(msg.action, msg.parameters, state);
          lastParam = msg.parameters;
          t.send(JSON.stringify({ proto_step: "report_state", state: encodeState(state) }));
          break;
        case "step_mismatch": {
          const hintText = msg.hints?.length
            ? `: ${renderDiffHints(msg.hints)}`
            : `: expected ${JSON.stringify(prettifyState(msg.expected))}, got ${JSON.stringify(prettifyState(msg.actual))}`;
          throw new Error(
              `step mismatch on action "${msg.action ?? lastAction}" with param "${lastParam}"${hintText}`
          );
        }
        case "protocol_error":
          throw new Error(msg.error);
        case "register_error":
          throw new Error(`register failed: ${msg.error}`);
        default:
          throw new Error(`unexpected message: ${msg.proto_step}`);
      }
      msg = await recv(it);
    }
  } finally {
    await closeOnce();
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
  try {
    return decodeMirrorMessage(value);
  } catch (err) {
    // Truncated snippet for diagnosis; the caller's close path (finally /
    // abort) tears the session down — a garbled line is unrecoverable.
    const snippet = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    throw new Error(`failed to decode mirror message: ${snippet}`, { cause: err });
  }
}

async function genTracesLoop(t: Transport): Promise<GenTracesResult> {
  const it = t[Symbol.asyncIterator]();
  let closed = false;
  const closeOnce = async () => {
    if (!closed) {
      closed = true;
      await t.close();
    }
  };
  try {
    const msg = await recv(it);
    if (msg.proto_step === "protocol_error") throw new Error(msg.error);
    if (msg.proto_step === "register_error") throw new Error(`register failed: ${msg.error}`);
    if (msg.proto_step === "gen_traces_done") {
      return { itfTracePaths: msg.itfTracePaths, itfTraces: msg.itfTraces ?? [] };
    }
    throw new Error(`expected gen_traces_done, got ${msg.proto_step}`);
  } finally {
    await closeOnce();
  }
}
