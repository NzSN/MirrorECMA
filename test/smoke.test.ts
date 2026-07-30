import {
  runClient,
  runClientWithTraces,
  runClientGenTraces,
  runClientExplore,
  startExploreSession,
  specFromFile,
  specFromFiles,
  presetClient,
  type ApalacheConfig,
  type TraceGenerationConfig,
  type StateComputer,
  type State,
  asInt,
  getParam,
} from "../src/index.js";

import { resolve } from "node:path";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { connectMirror, type Transport } from "../src/transport.js";

let BIN = process.env.MIRROR_BIN ?? "";
if (BIN && process.env.RUNFILES && !/^\//.test(BIN)) {
  BIN = resolve(process.env.RUNFILES, BIN);
}
if (!BIN) {
  console.error("MIRROR_BIN not set");
  process.exit(1);
}

const SPEC = process.env.SPEC ?? "./specs/Counter.tla";

const apalacheConfig: ApalacheConfig = {
  specPath: SPEC,
  invariant: "TraceComplete",
  lengthBound: 6,
  constInit: "CInit",
  paramVars: "parameters",
};

const traceConfig: TraceGenerationConfig = {
  numTraces: 100,
  view: "View"
};

class Counter {
  count: bigint;

  constructor() {
    this.count = 0n;
  }

  tick(stride: bigint): void {
    this.count += stride;
  }

  toState(): State {
    return {
      count: { tag: "int", val: this.count },
    };
  }
}

class CounterComputer {
  private counter = new Counter();

  compute(action: string, params: State, prevState: State): State {
    if (action === "Init" || !prevState.count) {
      this.counter = new Counter();
      return this.counter.toState();
    }

    const rec = getParam(params, "parameters");
    const stride = rec ? asInt(rec.stride!) ?? 0n : 0n;

    this.counter.tick(stride);
    return this.counter.toState();
  }
}

async function testRegister(target: string | Transport = BIN) {
  const computer = new CounterComputer();
  console.log(`Running smoke test (register) with spec: ${SPEC}`);
  await runClient(target, apalacheConfig, traceConfig, computer.compute.bind(computer));
  console.log("OK: register smoke test passed");
}

async function testRegisterTraces(target: string | Transport = BIN) {
  let tracePath = "specs/traces/violation.itf.json";
  if (process.env.RUNFILES) {
    tracePath = resolve(process.env.RUNFILES, "_main", tracePath);
  } else {
    tracePath = resolve(tracePath);
  }
  const states: State[] = [
    { count: { tag: "int", val: 0n } },
    { count: { tag: "int", val: 2n } },
    { count: { tag: "int", val: 4n } },
    { count: { tag: "int", val: 6n } },
    { count: { tag: "int", val: 8n } },
    { count: { tag: "int", val: 10n } },
    { count: { tag: "int", val: 13n } },
  ];

  console.log("Running smoke test (register_traces)");
  await runClientWithTraces(target, apalacheConfig, [tracePath], presetClient(states));
  console.log("OK: register_traces smoke test passed");
}

async function testRegisterGenTraces(target: string | Transport = BIN) {
  const destDir = await mkdtemp(tmpdir() + "/mirrorecma-gen-");
  console.log(`Running smoke test (register_trace_gen) with spec: ${SPEC}, dest: ${destDir}`);
  const result = await runClientGenTraces(target, apalacheConfig, destDir, traceConfig);
  const files = await readdir(destDir);
  const traceFiles = files.filter(f => f.endsWith(".itf.json"));
  if (traceFiles.length === 0) throw new Error("no trace files generated");
  if (result.itfTracePaths.length !== traceFiles.length)
    throw new Error(`expected ${traceFiles.length} paths, got ${result.itfTracePaths.length}`);
  if (result.itfTraces.length !== result.itfTracePaths.length)
    throw new Error(`expected ${result.itfTracePaths.length} inline traces, got ${result.itfTraces.length}`);
  for (const tr of result.itfTraces) {
    const states = (tr as { states?: unknown[] }).states;
    if (!Array.isArray(states) || states.length === 0)
      throw new Error("inline trace has no states");
  }
  console.log(`OK: register_trace_gen smoke test passed (${traceFiles.length} traces, inlined)`);
}

function hourClockSpecPath(): string {
  const p = "specs/HourClock.tla";
  return process.env.RUNFILES ? resolve(process.env.RUNFILES, "_main", p) : resolve(p);
}

// Faithful HourClock implementation: reports all 6 state vars, including
// action_taken — the mirror derives the action name from it and
// conformance-checks the full reported state.
// Note: mainLoop passes the received state as `params` for initial_state
// (prevState is {}), so init echoes params.
class HourClockComputer {
  compute(action: string, params: State, prevState: State): State {
    void action;
    if (!prevState.hr) return params;

    const oldHr = asInt(prevState.hr!) ?? 0n;
    const oldStep = asInt(prevState.step_count!) ?? 0n;
    return {
      hr: { tag: "int", val: oldHr !== 12n ? oldHr + 1n : 1n },
      latest_hr: { tag: "int", val: oldHr },
      ticked: { tag: "bool", val: true },
      action_taken: { tag: "str", val: "tick" },
      nondet_picks: prevState.nondet_picks!,
      step_count: { tag: "int", val: oldStep + 1n },
    };
  }
}

async function testExplore(target: string | Transport = BIN) {
  const spec = await specFromFile(hourClockSpecPath());
  console.log("Running smoke test (register_explore)");
  const computer = new HourClockComputer();
  await runClientExplore(target, spec, ["Inv"], [], 4, computer.compute.bind(computer));
  console.log("OK: register_explore smoke test passed");
}

async function testExploreSession(target: string | Transport = BIN) {  const spec = await specFromFile(hourClockSpecPath());
  console.log("Running smoke test (register_explore_session)");
  const session = await startExploreSession(target, spec, ["Inv"], []);

  const { initTransitions, nextTransitions, stateInvariants } = session.ready;
  if (initTransitions !== 1) throw new Error(`expected 1 init transition, got ${initTransitions}`);
  if (nextTransitions < 1) throw new Error(`expected >= 1 next transition, got ${nextTransitions}`);
  if (stateInvariants !== 1) throw new Error(`expected 1 state invariant, got ${stateInvariants}`);

  const status1 = await session.assumeTransition(0);
  if (status1 !== "ENABLED") throw new Error(`assumeTransition: expected ENABLED, got ${status1}`);

  const stepNo = await session.nextStep();
  if (stepNo !== 1) throw new Error(`nextStep: expected step 1, got ${stepNo}`);

  const state = await session.queryState();
  const hr = state.hr;
  if (!hr) throw new Error("queryState: state has no hr");

  const invStatus = await session.checkInvariant(0);
  if (invStatus !== "SATISFIED") throw new Error(`checkInvariant: expected SATISFIED, got ${invStatus}`);

  const status2 = await session.assumeState({ hr });
  if (status2 !== "ENABLED") throw new Error(`assumeState: expected ENABLED, got ${status2}`);

  const snap = await session.rollback(0);
  if (snap !== 0) throw new Error(`rollback: expected snapshot 0, got ${snap}`);

  await session.done();
  console.log("OK: register_explore_session smoke test passed");
}

// Faithful ExtMain implementation (2-module spec: ExtMain EXTENDS ExtDep).
// Full state = { count, action_taken }; init echoes the received state
// (mainLoop passes it as `params`), tick increments.
class ExtCounterComputer {
  compute(action: string, params: State, prevState: State): State {
    void action;
    if (!prevState.count) return params;
    return {
      count: { tag: "int", val: (asInt(prevState.count!) ?? 0n) + 1n },
      action_taken: { tag: "str", val: "tick" },
    };
  }
}

async function testRegisterInlineSpec(target: string | Transport = BIN) {
  const specDir = process.env.RUNFILES
    ? resolve(process.env.RUNFILES, "_main", "specs")
    : resolve("specs");
  const spec = await specFromFiles(resolve(specDir, "ExtMain.tla"));
  console.log(`Running smoke test (register with inline spec, ${spec.sources.length} modules)`);
  // specPath deliberately bogus: the mirror must use the inline sources.
  const cfg: ApalacheConfig = {
    specPath: "/nonexistent/ExtMain.tla",
    invariant: "TraceComplete",
    lengthBound: 3,
  };
  const computer = new ExtCounterComputer();
  await runClient(target, cfg, { numTraces: 1 }, computer.compute.bind(computer), { spec });
  console.log("OK: register with inline spec smoke test passed");
}

// Spawn the mirror as a TCP daemon (`--serve <port>`), wait until it accepts
// connections, run every scenario over fresh connections, then kill the
// daemon. The daemon serves the connections sequentially via its accept loop.
function tcpTarget(port: number): Transport {
  return connectMirror("127.0.0.1", port);
}

async function testOverTcp() {
  const port = 10000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn(BIN, ["--serve", String(port)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  try {
    let connected = false;
    for (let i = 0; i < 50 && !connected; i++) {
      try {
        const probe = connectMirror("127.0.0.1", port);
        await probe.ready;
        await probe.close();
        connected = true;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!connected) throw new Error("mirror daemon did not start listening");

    console.log("Running smoke tests over TCP");
    await testRegister(tcpTarget(port));
    await testRegisterTraces(tcpTarget(port));
    await testRegisterGenTraces(tcpTarget(port));
    await testExplore(tcpTarget(port));
    await testExploreSession(tcpTarget(port));
    await testRegisterInlineSpec(tcpTarget(port));
    console.log("OK: all TCP smoke tests passed");
  } finally {
    child.kill();
  }
}

async function main() {
  await testRegister();
  await testRegisterTraces();
  await testRegisterGenTraces();
  await testExplore();
  await testExploreSession();
  await testRegisterInlineSpec();
  await testOverTcp();
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
