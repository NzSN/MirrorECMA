import { spawnMirror } from "./transport.js";
import {
  MirrorMessage,
  State,
  StateComputer,
  TraceGenerationConfig,
  encodeClientMessage,
  encodeState,
  decodeMirrorMessage,
  prettifyState,
} from "./protocol.js";
import type { Transport } from "./transport.js";

export type { State, StateComputer, TraceGenerationConfig } from "./protocol.js";

export async function runClientWithTraces(
  binPath: string,
  tracePaths: string[],
  compute: StateComputer
): Promise<void> {
  const t = spawnMirror(binPath);
  t.send(encodeClientMessage({
    proto_step: "register_traces",
    itfTracePaths: tracePaths,
  }));
  await mainLoop(t, compute);
}

export async function runClient(
  binPath: string,
  specPath: string,
  config: TraceGenerationConfig,
  compute: StateComputer
): Promise<void> {
  const t = spawnMirror(binPath);
  t.send(encodeClientMessage({
    proto_step: "register",
    specPath,
    traceConfig: config,
  }));
  await mainLoop(t, compute);
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
