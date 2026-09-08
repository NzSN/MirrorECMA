import { runClientWithTraces, runClientWithTracesWithReport } from "../src/client.js";
import { ReplayMismatchError, ReplayRecorder, replayReportFromError } from "../src/replay-report.js";
import type { ApalacheConfig, State } from "../src/protocol.js";
import type { Transport } from "../src/transport.js";

const config: ApalacheConfig = { specPath: "Counter.tla", invariant: "Inv", lengthBound: 2 };
const valid = { proto_step: "spec_validated", result: "valid" };
const init = { proto_step: "initial_state", action: "init", state: {} };
const next = { proto_step: "next_step", action: "tick", parameters: {} };
const ok = { proto_step: "step_ok" };
const done = { proto_step: "all_steps_done" };

class ScriptedTransport implements Transport {
  sent: string[] = [];
  closes = 0;
  constructor(private replies: unknown[], private closeError?: Error) {}
  send(line: string): void { this.sent.push(line); }
  async close(): Promise<number> {
    this.closes += 1;
    if (this.closeError) throw this.closeError;
    return 0;
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for (const reply of this.replies) yield typeof reply === "string" ? reply : JSON.stringify(reply);
  }
}

test("counts confirmed states and transitions across traces without double acknowledgments", async () => {
  const t = new ScriptedTransport([valid, init, ok, next, ok, next, init, ok, next, done]);
  const report = await runClientWithTracesWithReport(t, config, [], () => ({}));
  expect(report).toMatchObject({
    schema: "mirrorecma.replay-report/v1", status: "passed",
    tracesStarted: 2, tracesCompleted: 2, statesReported: 5, statesMatched: 5,
    stepsCompleted: 3, actionCounts: { init: 2, tick: 3 },
    sequenceCounts: [{ from: "init", to: "tick", count: 2 }, { from: "tick", to: "tick", count: 1 }],
  });
  expect(report.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  expect(Object.isFrozen(report)).toBe(true);
  expect(Object.isFrozen(report.sequenceCounts[0])).toBe(true);
  expect(() => Object.assign(report.actionCounts, { init: 99 })).toThrow();
  expect(t.closes).toBe(1);
});

test("legacy runners still return void and preserve ITF report bytes", async () => {
  const t = new ScriptedTransport([valid, init, done]);
  const result = await runClientWithTraces(t, config, [], () => ({ count: { tag: "int", val: 2n } }));
  expect(result).toBeUndefined();
  expect(t.sent[1]).toBe('{"proto_step":"report_state","state":{"count":{"#bigint":"2"}}}');
});

test("mismatch snapshots retain bigint, ordered hints, actual inputs and trace position", async () => {
  const huge = "9007199254740993123456789";
  const t = new ScriptedTransport([
    valid, init, next, init,
    { ...next, parameters: { stride: { "#bigint": huge } } },
    { proto_step: "step_mismatch", expected: { count: { "#bigint": huge } },
      actual: { count: { "#bigint": "1" } }, hints: [
        { kind: "value_mismatch", path: [{ field: "count" }],
          expected: { "#bigint": huge }, actual: { "#bigint": "1" } },
        { kind: "truncated", path: [] },
      ] },
  ]);
  let callbackParams: State = {};
  let failure: unknown;
  try {
    await runClientWithTracesWithReport(t, config, [], (_action, params) => {
      callbackParams = params;
      if (params.stride) params.stride = { tag: "int", val: -1n };
      return {};
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ReplayMismatchError);
  const error = failure as ReplayMismatchError;
  expect(error).toMatchObject({ action: "tick", traceIndex: 2, stateIndex: 1,
    params: { stride: { tag: "int", val: BigInt(huge) } } });
  expect(error.message).not.toContain("[object Object]");
  expect(error.message).toContain(huge);
  expect(error.report).toMatchObject({ status: "failed", tracesStarted: 2, tracesCompleted: 1,
    statesReported: 4, statesMatched: 3, stepsCompleted: 1 });
  expect(JSON.parse(JSON.stringify(error))).toMatchObject({
    params: { stride: { "#bigint": huge } }, expected: { count: { "#bigint": huge } },
    hints: [{ kind: "value_mismatch", expected: { "#bigint": huge } }, { kind: "truncated" }],
  });
  expect(Object.isFrozen(error.params.stride)).toBe(true);
  expect(Object.isFrozen(callbackParams)).toBe(false);
  expect(replayReportFromError(error)).toBe(error.report);
  expect(t.closes).toBe(1);
});

test("initialization mismatch records initial inputs, including on later traces", async () => {
  const t = new ScriptedTransport([valid, init, next,
    { ...init, state: { seed: { "#bigint": "10" } } },
    { proto_step: "step_mismatch", expected: {}, actual: {} }]);
  await expect(runClientWithTracesWithReport(t, config, [], () => ({}))).rejects.toMatchObject({
    traceIndex: 2, stateIndex: 0, params: { seed: { tag: "int", val: 10n } },
  });
});

test("application failure keeps identity and a report when transport cleanup also fails", async () => {
  const error = Object.freeze(new Error("application failed"));
  const t = new ScriptedTransport([valid, init], new Error("close failed"));
  await expect(runClientWithTracesWithReport(t, config, [], () => { throw error; })).rejects.toBe(error);
  expect(replayReportFromError(error)).toMatchObject({ status: "failed", statesReported: 0 });
  expect(t.closes).toBe(1);
});

test("registration send failure closes once without replacing the send error", async () => {
  const error = new Error("send failed");
  const t = new ScriptedTransport([], new Error("close failed"));
  t.send = () => { throw error; };
  await expect(runClientWithTracesWithReport(t, config, [], () => ({}))).rejects.toBe(error);
  expect(t.closes).toBe(1);
});

test("coverage aggregates cap distinct names and pairs while retaining complete progress counts", async () => {
  const replies: unknown[] = [valid, init];
  for (let index = 0; index < 1100; index += 1) replies.push({ ...next, action: `action-${index}` });
  // Both the initial action and this first pair must continue counting after caps.
  replies.push({ ...next, action: "init" }, { ...next, action: "action-0" }, done);
  const report = await runClientWithTracesWithReport(new ScriptedTransport(replies), config, [], () => ({}));
  expect(Object.keys(report.actionCounts)).toHaveLength(256);
  expect(report.sequenceCounts).toHaveLength(1024);
  expect(report.coverage).toEqual({ actionLimit: 256, sequenceLimit: 1024,
    droppedActionEvents: 845, droppedSequenceEvents: 77, truncated: true });
  expect(report.actionCounts.init).toBe(2);
  expect(report.actionCounts["action-0"]).toBe(2);
  expect(report.sequenceCounts.find((pair) => pair.from === "init" && pair.to === "action-0")?.count).toBe(2);
  expect(report).toMatchObject({ statesReported: 1103, statesMatched: 1103, stepsCompleted: 1102,
    tracesStarted: 1, tracesCompleted: 1 });
});

test("readiness rejection closes the owned transport and preserves the primary error", async () => {
  const failure = new Error("not ready");
  const transport = Object.assign(new ScriptedTransport([], new Error("close failed")), {
    ready: Promise.reject(failure),
  });
  let computations = 0;
  await expect(runClientWithTracesWithReport(transport, config, [], () => { computations += 1; return {}; }))
    .rejects.toBe(failure);
  expect(computations).toBe(0);
  expect(transport.sent).toHaveLength(0);
  expect(transport.closes).toBe(1);
});

test.each(["null prototype", "throwing getters", "same object rethrow", "revoked proxy"])(
  "unprintable application rejection preserves identity, report and cleanup: %s", async (kind) => {
    let failure: object;
    if (kind === "null prototype") failure = Object.create(null);
    else if (kind === "revoked proxy") {
      const revoked = Proxy.revocable({}, {});
      failure = revoked.proxy;
      revoked.revoke();
    } else {
      failure = Object.create(null, {
        code: { get: () => { throw kind === "same object rethrow" ? failure : new Error("code getter failed"); } },
        message: { get: () => { throw kind === "same object rethrow" ? failure : new Error("message getter failed"); } },
      });
    }
    const transport = new ScriptedTransport([valid, init], new Error("secondary cleanup failed"));
    let caught: unknown;
    try { await runClientWithTracesWithReport(transport, config, [], () => { throw failure; }); }
    catch (error) { caught = error; }
    // Avoid matcher inspection of the deliberately hostile proxy/accessors.
    expect(caught === failure).toBe(true);
    expect(replayReportFromError(failure)).toMatchObject({ status: "failed",
      failure: { code: "replay_failed", message: "replay failed (unprintable rejection)" } });
    expect(transport.closes).toBe(1);
  },
);

test.each([undefined, null, 0, false, ""])("primitive application rejection stays rejected: %s", async (failure) => {
  const transport = new ScriptedTransport([valid, init], new Error("secondary cleanup failed"));
  let rejected = false;
  try { await runClientWithTracesWithReport(transport, config, [], () => { throw failure; }); }
  catch (error) { rejected = true; expect(Object.is(error, failure)).toBe(true); }
  expect(rejected).toBe(true);
  expect(transport.closes).toBe(1);
  expect(new ReplayRecorder().report(failure)).toMatchObject({ status: "failed",
    failure: { code: "replay_failed", message: String(failure) } });
});

test("undefined cleanup rejection still fails an otherwise successful legacy run", async () => {
  const transport = new ScriptedTransport([valid, init, done]);
  transport.close = async () => { transport.closes += 1; throw undefined; };
  let rejected = false;
  try { await runClientWithTracesWithReport(transport, config, [], () => ({})); }
  catch (error) { rejected = true; expect(error).toBeUndefined(); }
  expect(rejected).toBe(true);
  expect(transport.closes).toBe(1);
});
