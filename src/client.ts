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
} from "./protocol.js";
import type { Transport } from "./transport.js";
import { readFile } from "node:fs/promises";
import { receiveReplayMessage, runLegacyReplay } from "./replay.js";

export {
  runClientNegotiated,
  runClientWithTracesNegotiated,
} from "./negotiated.js";
export type {
  AdapterFactory,
  CompiledAdapterKey,
  CompiledAdapterRegistration,
  CompiledAdapterSelection,
  LocalBinding,
  NegotiatedRunOptions,
  NegotiatedRunnerErrorCode,
} from "./negotiated.js";
export {
  CompiledAdapterRegistry,
  MIRRORECMA_TARGET_PROFILE,
  ModelInterfaceRegistrationError,
  NegotiatedRunnerError,
  STATE_COMPUTER_CONTRACT_VERSION,
} from "./negotiated.js";

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
  await runLegacyReplay(t, compute);
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
  await runLegacyReplay(t, compute);
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
  await runLegacyReplay(t, compute);
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
      const msg = await receiveReplayMessage(it);
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
      msg = await receiveReplayMessage(this.it);
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
      msg = await receiveReplayMessage(this.it);
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

export function presetClient(states: State[]): StateComputer {
  let i = 0;
  return () => {
    if (i >= states.length) throw new Error("presetClient exhausted");
    return states[i++]!;
  };
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
    const msg = await receiveReplayMessage(it);
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
