import { runClientWithTracesWithReport } from "../src/client.js";
import type { ReplayContext, ReplayOptions } from "../src/replay-control.js";
import { replayReportFromError } from "../src/replay-report.js";
import type { ApalacheConfig, State } from "../src/protocol.js";
import type { Transport } from "../src/transport.js";

const config: ApalacheConfig = { specPath: "Counter.tla", invariant: "Inv", lengthBound: 2 };
const valid = JSON.stringify({ proto_step: "spec_validated", result: "valid" });
const init = JSON.stringify({ proto_step: "initial_state", action: "init", state: {} });
const next = JSON.stringify({ proto_step: "next_step", action: "tick", parameters: {} });
const done = JSON.stringify({ proto_step: "all_steps_done" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ScriptedTransport implements Transport {
  readonly sent: string[] = [];
  closes = 0;
  pulls = 0;
  constructor(private replies: (string | Promise<string>)[]) {}
  send(line: string): void { this.sent.push(line); }
  async close(): Promise<number> { this.closes += 1; return 0; }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for (const reply of this.replies) { this.pulls += 1; yield await reply; }
  }
}

test("awaits the complete operation before reporting, then passes the observed previous state", async () => {
  const started = deferred<void>();
  const operation = deferred<State>();
  const t = new ScriptedTransport([valid, init, next, done]);
  const calls: { action: string; prev: State; context: ReplayContext }[] = [];
  const run = runClientWithTracesWithReport(t, config, [], async (action, _params, prev, context) => {
    calls.push({ action, prev, context });
    if (action === "init") { started.resolve(); return operation.promise; }
    return { count: { tag: "int", val: 2n } };
  });
  await started.promise;
  expect(t.sent).toHaveLength(1);
  expect(t.pulls).toBe(2);
  operation.resolve({ count: { tag: "int", val: 1n } });
  const report = await run;
  expect(calls[1]).toMatchObject({ action: "tick", prev: { count: { tag: "int", val: 1n } },
    context: { traceIndex: 1, stateIndex: 1 } });
  expect(report).toMatchObject({ statesMatched: 2, stepsCompleted: 1 });
  expect(t.closes).toBe(1);
});

test("action timeout aborts its context and ignores late success", async () => {
  const started = deferred<ReplayContext>();
  const operation = deferred<State>();
  const t = new ScriptedTransport([valid, init, next, done]);
  const run = runClientWithTracesWithReport(t, config, [], async (_action, _params, _prev, context) => {
    started.resolve(context);
    return operation.promise;
  }, { actionTimeoutMs: 10 });
  const context = await started.promise;
  await expect(run).rejects.toMatchObject({ code: "action_timeout" });
  expect(context.signal.aborted).toBe(true);
  operation.resolve({ count: { tag: "int", val: 1n } });
  await Promise.resolve();
  expect(t.sent).toHaveLength(1);
  expect(t.pulls).toBe(2);
  expect(t.closes).toBe(1);
});

test("an over-budget synchronous callback cannot report before delayed timers run", async () => {
  const t = new ScriptedTransport([valid, init, done]);
  await expect(runClientWithTracesWithReport(t, config, [], () => {
    const until = performance.now() + 5;
    while (performance.now() < until) { /* Simulate synchronous SUT work. */ }
    return {};
  }, { actionTimeoutMs: 1 })).rejects.toMatchObject({ code: "action_timeout" });
  expect(t.sent).toHaveLength(1);
  expect(t.closes).toBe(1);
});

test("external cancellation during an action is terminal and consumes late rejection", async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const operation = deferred<State>();
  const t = new ScriptedTransport([valid, init, done]);
  const run = runClientWithTracesWithReport(t, config, [], async () => {
    started.resolve(); return operation.promise;
  }, { signal: controller.signal });
  await started.promise;
  controller.abort("user cancelled");
  await expect(run).rejects.toMatchObject({ code: "replay_aborted", cause: "user cancelled" });
  operation.reject(new Error("late failure"));
  await Promise.resolve();
  expect(t.sent).toHaveLength(1);
  expect(t.closes).toBe(1);
});

test("pre-aborted runs send nothing and still close the supplied transport", async () => {
  const controller = new AbortController();
  controller.abort();
  const t = new ScriptedTransport([valid, init, done]);
  await expect(runClientWithTracesWithReport(t, config, [], () => { throw new Error("must not run"); },
    { signal: controller.signal })).rejects.toMatchObject({ code: "replay_aborted" });
  expect(t.sent).toHaveLength(0);
  expect(t.pulls).toBe(0);
  expect(t.closes).toBe(1);
});

test.each([false, true])("receive deadline covers registration and replay, afterRegistration=%s", async (afterRegistration) => {
  const never = deferred<string>();
  const t = new ScriptedTransport(afterRegistration ? [valid, never.promise] : [never.promise]);
  let failure: unknown;
  try { await runClientWithTracesWithReport(t, config, [], () => ({}), { receiveTimeoutMs: 10 }); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "receive_timeout" });
  expect(replayReportFromError(failure)).toMatchObject({ status: "failed", statesReported: 0 });
  expect(t.closes).toBe(1);
});

test.each([0, -1, NaN, Infinity, 2_147_483_648])("invalid timeouts fail before registration: %s", async (timeout) => {
  for (const options of [{ actionTimeoutMs: timeout }, { receiveTimeoutMs: timeout }] satisfies ReplayOptions[]) {
    const t = new ScriptedTransport([]);
    await expect(runClientWithTracesWithReport(t, config, [], () => ({}), options)).rejects.toBeInstanceOf(RangeError);
    expect(t.sent).toHaveLength(0);
  }
});

test("callback progress reports preserve synchronous compute-to-encode ordering", async () => {
  const t = new ScriptedTransport([valid, init, done]);
  await runClientWithTracesWithReport(t, config, [], () => {
    const state: State = { count: { tag: "int", val: 1n } };
    queueMicrotask(() => { state.count = { tag: "int", val: 2n }; });
    return state;
  });
  const line = t.sent.find((item) => item.includes("report_state"))!;
  expect(JSON.parse(line).state.count).toEqual({ "#bigint": "1" });
});
