import { replayCore } from "./replay-core.js";
import {
  decodeMirrorMessage,
  type MirrorMessage,
} from "./protocol.js";
import type { Transport } from "./transport.js";
import { ReplayControl, type ReplayComputer, type ReplayOptions } from "./replay-control.js";
import {
  attachReplayReport, failedReplayReport, ReplayRecorder,
  type ReplayReport,
} from "./replay-report.js";

/** Receive one complete JSONL payload without interpreting additive fields. */
export async function receiveLine(it: AsyncIterator<string>, control?: ReplayControl): Promise<string> {
  const { value, done } = await (control ? control.run("receive", () => it.next()) : it.next());
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
  control?: ReplayControl,
): Promise<MirrorMessage> {
  return decodeReplayMessage(await receiveLine(it, control));
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
 * preserves the legacy outbound bytes. Reports contain aggregate progress only.
 */
export async function replayLoop(
  t: Transport,
  it: AsyncIterator<string>,
  compute: ReplayComputer,
  control: ReplayControl = new ReplayControl(),
  recorder: ReplayRecorder = new ReplayRecorder(),
): Promise<ReplayReport> {
  try {
    await replayCore(t, it, {
      start: (action, payload, previous) => {
        const result = control.startAction(() => compute(
          action, payload, previous, { signal: control.signal, ...recorder.position },
        ));
        return result.kind === "ready"
          ? { kind: "ready", state: result.value }
          : { kind: "pending", state: result.value };
      },
    }, {
      receive: () => receiveReplayMessage(it, control),
      progress: { recorder, assertActive: () => control.assertActive() },
    });
    return recorder.complete();
  } catch (error) {
    attachReplayReport(error, recorder.report(error));
    throw error;
  }
}

/** Run the historical registration barrier and replay lifecycle. */
export async function runLegacyReplay(
  t: Transport,
  compute: ReplayComputer,
  options: ReplayOptions = {},
  register?: () => void,
): Promise<ReplayReport> {
  const control = new ReplayControl(options);
  const recorder = new ReplayRecorder();
  const it = t[Symbol.asyncIterator]();
  let report: ReplayReport | undefined;
  let primaryError: unknown;
  let failed = false;
  try {
    control.assertActive();
    register?.();
    requireValidRegistration(await receiveReplayMessage(it, control));
    report = await replayLoop(t, it, compute, control, recorder);
  } catch (error) {
    failed = true;
    primaryError = error;
    attachReplayReport(error, recorder.report(error));
  } finally {
    control.dispose();
  }
  try { await t.close(); } catch (error) {
    if (!failed) {
      failed = true;
      primaryError = error;
      attachReplayReport(error, report ? failedReplayReport(report, error) : recorder.report(error));
    }
  }
  if (failed) throw primaryError;
  return report!;
}
