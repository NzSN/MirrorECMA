import { runClient, type TraceGenerationConfig, type StateComputer } from "../src/index.js";

const BIN = process.env.MIRROR_BIN ?? "";
const SPEC = "./specs/Counter.tla";

const runSmoke = BIN ? test : test.skip;

const config: TraceGenerationConfig = {
  invariant: "TraceComplete",
  lengthBound: 5,
  numTraces: 1,
  cinit: "CInit",
  paramVars: "parameters",
};

const compute: StateComputer = (action, params, prevState) => {
  if (action === "Init" || !prevState.count) {
    return {
      count: { tag: "int", val: 0n },
      action_taken: { tag: "str", val: "init" },
      step_count: { tag: "int", val: 0n },
    };
  }

  const stride = params.parameters?.tag === "record"
    ? params.parameters.val.stride?.tag === "int"
      ? params.parameters.val.stride.val
      : 0n
    : 0n;

  const prevCount = prevState.count?.tag === "int" ? prevState.count.val : 0n;
  const prevStep = prevState.step_count?.tag === "int" ? prevState.step_count.val : 0n;

  return {
    count: { tag: "int", val: prevCount + stride },
    action_taken: { tag: "str", val: "tick" },
    step_count: { tag: "int", val: prevStep + 1n },
  };
};

describe("smoke test", () => {
  runSmoke("Counter.tla end-to-end", async () => {
    const start = Date.now();
    await runClient(BIN, SPEC, config, compute);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(60000);
    console.log(`OK (${elapsed}ms)`);
  }, 120000);
});
