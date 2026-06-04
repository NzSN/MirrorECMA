import { runClient, type TraceGenerationConfig, type StateComputer, type State, asInt, getParam } from "../src/index.js";

const BIN = process.env.MIRROR_BIN ?? "";
const SPEC = "./specs/Counter.tla";

const runSmoke = BIN ? test : test.skip;

const config: TraceGenerationConfig = {
  invariant: "TraceComplete",
  lengthBound: 6,
  numTraces: 1,
  cinit: "CInit",
  paramVars: "parameters",
};

class Counter {
  count: bigint;

  constructor() {
    this.count = 0n;
  }

  tick(stride: bigint): void {
    this.count += stride + BigInt(1);
  }

  toState(): State {
    return {
      count: { tag: "int", val: this.count }
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

describe("smoke test", () => {
  runSmoke("Counter.tla end-to-end", async () => {
    const start = Date.now();
    const computer = new CounterComputer();
    await runClient(BIN, SPEC, config, computer.compute.bind(computer));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(60000);
    console.log(`OK (${elapsed}ms)`);
  }, 120000);
});
