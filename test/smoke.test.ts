import {
  runClient,
  runClientWithTraces,
  presetClient,
  type TraceGenerationConfig,
  type StateComputer,
  type State,
  asInt,
  getParam,
} from "../src/index.js";

import { resolve } from "node:path";

let BIN = process.env.MIRROR_BIN ?? "";
if (BIN && process.env.RUNFILES && !/^\//.test(BIN)) {
  BIN = resolve(process.env.RUNFILES, BIN);
}
if (!BIN) {
  console.error("MIRROR_BIN not set");
  process.exit(1);
}

const SPEC = process.env.SPEC ?? "./specs/Counter.tla";

const config: TraceGenerationConfig = {
  invariant: "TraceComplete",
  lengthBound: 6,
  numTraces: 100,
  cinit: "CInit",
  paramVars: "parameters",
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

async function testRegister() {
  const computer = new CounterComputer();
  console.log(`Running smoke test (register) with spec: ${SPEC}`);
  await runClient(BIN, SPEC, config, computer.compute.bind(computer));
  console.log("OK: register smoke test passed");
}

async function testRegisterTraces() {
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
  await runClientWithTraces(BIN, [tracePath], presetClient(states));
  console.log("OK: register_traces smoke test passed");
}

async function main() {
  await testRegister();
  await testRegisterTraces();
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
