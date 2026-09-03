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
  if (message.proto_step === "register_error") {
    throw new Error(`register failed: ${message.error}`);
  }
  if (message.proto_step !== "spec_validated") {
    throw new Error(`expected spec_validated, got ${message.proto_step}`);
  }
  if (typeof message.result !== "string") {
    throw new Error(`spec invalid: ${message.result.invalid}`);
  }
}

/**
 * Shared trace replay state machine. The caller owns registration negotiation,
 * transport closure, and any binding cleanup. This function intentionally
 * preserves the legacy outbound bytes and error messages.
 */
export async function replayLoop(
  t: Transport,
  it: AsyncIterator<string>,
  compute: StateComputer,
): Promise<void> {
  let msg = await receiveReplayMessage(it);
  let state: State = {};
  let lastParam: State = {};
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
          `step mismatch on action "${msg.action ?? lastAction}" with param "${lastParam}"${hintText}`,
        );
      }
      case "protocol_error":
        throw new Error(msg.error);
      case "register_error":
        throw new Error(`register failed: ${msg.error}`);
      default:
        throw new Error(`unexpected message: ${msg.proto_step}`);
    }
    msg = await receiveReplayMessage(it);
  }
}

/** Run the historical registration barrier and replay lifecycle. */
export async function runLegacyReplay(
  t: Transport,
  compute: StateComputer,
): Promise<void> {
  const it = t[Symbol.asyncIterator]();
  let closed = false;
  const closeOnce = async () => {
    if (!closed) {
      closed = true;
      await t.close();
    }
  };
  try {
    requireValidRegistration(await receiveReplayMessage(it));
    await replayLoop(t, it, compute);
  } finally {
    await closeOnce();
  }
}
