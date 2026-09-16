import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeSemanticDescriptor } from "../src/model-interface.js";
import { MatchedEvidenceTracker } from "../src/matched-evidence.js";
import { replayCore, synchronousReplayExecution } from "../src/replay-core.js";
import type { Transport } from "../src/transport.js";

const lock = JSON.parse(readFileSync(resolve("test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json"), "utf8"));
const { contract: _contract, semanticDigest: _digest, provenance: _provenance, provenanceDigest: _pd, ...descriptorFields } = lock;
const descriptor = decodeSemanticDescriptor({ ...descriptorFields, schema: "mirrors.model-interface-descriptor/v1" });
function tracker(lengths = [3]) {
  return new MatchedEvidenceTracker(descriptor, { requiredActions: ["Tick"], requiredPairs: [["Tick", "Tick"]] }, lengths);
}
function report(t: MatchedEvidenceTracker, initial: boolean, label: string) { t.begin(initial, label); t.reported(); }

test("only matched transitions and adjacent pairs count; terminal commits once", () => {
  const t = tracker();
  report(t, true, "init"); t.acknowledge();
  report(t, false, "tick");
  expect(t.snapshot().requiredActionCounts[0]?.count).toBe(0);
  t.acknowledge();
  report(t, false, "tick"); t.acknowledge(); t.done();
  expect(t.snapshot()).toMatchObject({ corpusCompleted: true, exact: true, initialStatesMatched: 1,
    transitionsMatched: 2, statesReported: 3, requiredActionCounts: [{ id: "Tick", count: 2 }],
    requiredPairCounts: [{ from: "Tick", to: "Tick", count: 1 }] });
  expect(() => t.done()).toThrow("already sealed");
});
test("legacy serial advancement and terminal alone acknowledge pending states", () => {
  const t = tracker();
  report(t, true, "init"); report(t, false, "tick"); report(t, false, "tick"); t.done();
  expect(t.snapshot().transitionsMatched).toBe(2);
});
test("mismatch rejects the pending observation without erasing proven prefix", () => {
  const t = tracker(); report(t, true, "init"); t.acknowledge();
  report(t, false, "tick"); t.interrupt(true);
  expect(t.snapshot()).toMatchObject({ exact: true, corpusCompleted: false, initialStatesMatched: 1,
    transitionsMatched: 0, statesReported: 2 });
});
test("EOF after send marks missing acknowledgement; final ack without terminal is incomplete", () => {
  const t = tracker([1]); report(t, true, "init"); t.interrupt();
  expect(t.snapshot()).toMatchObject({ exact: false, initialStatesMatched: 0, uncertainty: ["missing_ack"] });
  const u = tracker([1]); report(u, true, "init"); u.acknowledge(); u.interrupt();
  expect(u.snapshot()).toMatchObject({ corpusCompleted: false, exact: true, initialStatesMatched: 1 });
});
test("initialization resets pair adjacency and repeated traces remain distinct", () => {
  const t = tracker([2, 2]);
  for (let n = 0; n < 2; n++) { report(t, true, "init"); report(t, false, "tick"); t.acknowledge(); }
  t.done();
  expect(t.snapshot()).toMatchObject({ tracesCompleted: 2, transitionsMatched: 2,
    requiredPairCounts: [{ from: "Tick", to: "Tick", count: 0 }] });
});
test("aliases map to stable IDs and mappings fail before implementation dispatch", () => {
  const aliased = { ...descriptor, actions: descriptor.actions.map(a => ({ ...a, wireAliases: ["advance"] })) };
  const t = new MatchedEvidenceTracker(aliased, { requiredActions: ["Tick"], requiredPairs: [] }, [2]);
  report(t, true, "init"); report(t, false, "advance"); t.done();
  expect(t.snapshot().requiredActionCounts[0]?.count).toBe(1);
  expect(() => tracker().begin(true, "unknown")).toThrow("action label");
  expect(() => tracker().begin(false, "tick")).toThrow("outside preflight");
});
test("preflight counts reject missing traces, premature resets, and extra states", () => {
  const t = tracker([1, 1]); report(t, true, "init");
  expect(() => t.done()).toThrow("all selected traces");
  const u = tracker([3]); report(u, true, "init");
  expect(() => u.begin(true, "init")).toThrow("preflight state count");
  const v = tracker([1]); report(v, true, "init");
  expect(() => v.begin(false, "tick")).toThrow("preflight trace bounds");
  expect(() => tracker().acknowledge()).toThrow("without pending");
});
test("snapshots cannot mutate tracker counters", () => {
  const t = tracker([1]); const before = t.snapshot(); report(t, true, "init"); t.done();
  expect(before.initialStatesMatched).toBe(0);
  expect(Object.isFrozen(before.requiredActionCounts[0])).toBe(true);
});
async function sequence(messages: object[], t: MatchedEvidenceTracker, failSend = false) {
  const transport: Transport = {
    send() { if (failSend) throw new Error("send failed"); },
    async close() { return 0; },
    async *[Symbol.asyncIterator]() { for (const msg of messages) yield JSON.stringify(msg); },
  };
  return replayCore(transport, transport[Symbol.asyncIterator](), synchronousReplayExecution(() => ({})), { matchedEvidence: t });
}
const init = { proto_step: "initial_state", action: "init", state: {} };
const next = { proto_step: "next_step", action: "tick", parameters: {} };
const ack = { proto_step: "step_ok" };
const done = { proto_step: "all_steps_done" };
test("actual replay loop connects report, acknowledgements, and terminal", async () => {
  const t = tracker([2]); await sequence([init, ack, next, ack, done], t);
  expect(t.snapshot()).toMatchObject({ corpusCompleted: true, statesReported: 2, transitionsMatched: 1 });
});
test("replay loop records neither failed sends nor unacknowledged states as matched", async () => {
  const t = tracker([1]); await expect(sequence([init], t)).rejects.toThrow("closed");
  expect(t.snapshot().initialStatesMatched).toBe(0);
  const u = tracker([1]); await expect(sequence([init], u, true)).rejects.toThrow("send failed");
  expect(u.snapshot().statesReported).toBe(0);
});
test.each([
  ["before any report", [], 0],
  ["after acknowledgement", [init, ack], 1],
] as const)("mismatch %s is protocol uncertainty, not authoritative rejection", async (_label, prefix, matched) => {
  const t = tracker([1]);
  await expect(sequence([...prefix, { proto_step: "step_mismatch", expected: {}, actual: {} }], t))
    .rejects.toMatchObject({ code: "evidence_invalid", message: "rejection without pending observation" });
  expect(t.snapshot()).toMatchObject({
    corpusCompleted: false, exact: false, initialStatesMatched: matched, uncertainty: ["protocol"],
  });
});

// Enabled explicitly by the compiler/client coordinated gate; uses a real mirror.
(process.env.MIRROR_BIN ? test : test.skip)("real mirror distinguishes matched and rejected Counter observations", async () => {
  const { AsyncCompiledAdapterRegistry } = await import("../src/adapter-registry.js");
  const { runClientWithTracesNegotiatedWithReport } = await import("../src/negotiated.js");
  const { semanticDigestFromHex } = await import("../src/model-interface.js");
  const { bindCounterAsync, CounterModelInterface } = await import("./fixtures/model-interface/counter/generated-async/CounterMirror.generated.js");
  const trace = resolve("test/fixtures/model-interface/counter/counter.itf.json");
  const stateCount = JSON.parse(readFileSync(trace, "utf8")).states.length;
  const config = { specPath: resolve("examples/generated-counter/specs/Counter.tla"), invariant: "TraceComplete",
    lengthBound: 6, constInit: "CInit", paramVars: "parameters" };
  for (const broken of [false, true]) {
    let count = 0n;
    let factories = 0;
    let disposals = 0;
    const semanticDigest = semanticDigestFromHex(lock.semanticDigest);
    const key = { semanticDigest, adapterId: "matched-evidence-test", targetProfile: "mirrorecma-async-v1",
      stateComputerContractVersion: "mirrors.async-state-computer/v1" };
    const registry = new AsyncCompiledAdapterRegistry([{ key, factory: effective => {
      factories += 1;
      const binding = bindCounterAsync({
        initialize: async () => { count = 0n; },
        tick: async ({ stride }) => { count += stride - (broken ? 1n : 0n); },
        observe: async () => ({ count }),
      }, effective);
      return { ...binding, semanticDigest, dispose() { disposals += 1; } };
    } }]);
    const t = tracker([stateCount]);
    const run = runClientWithTracesNegotiatedWithReport(process.env.MIRROR_BIN!, config, [trace],
      { execution: "async", metadata: CounterModelInterface, registry, ...key }, { matchedEvidence: t });
    if (broken) {
      await expect(run).rejects.toMatchObject({ code: "replay_mismatch" });
      expect(t.snapshot()).toMatchObject({ corpusCompleted: false, transitionsMatched: 0, statesReported: 2 });
    } else {
      await run;
      expect(t.snapshot()).toMatchObject({ corpusCompleted: true, transitionsMatched: stateCount - 1 });
    }
    expect(factories).toBe(1); expect(disposals).toBe(1);
  }
}, 15000);
