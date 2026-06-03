import { runClient, presetClient, type TraceGenerationConfig, type Value } from "../dist/index.js";

const BIN = process.env.MIRROR_BIN ?? "../ModelMirros/dist-newstyle/build/x86_64-linux/ghc-9.14.1/ModelMirros-0.1.0.0/x/ModelMirros/build/ModelMirros/ModelMirros";
const SPEC = process.env.MIRROR_SPEC ?? "../ModelMirros/test/specs/DeterministicCounter.tla";

const config: TraceGenerationConfig = {
  invariant: "TraceComplete",
  lengthBound: 5,
  numTraces: 1,
};

const v = (n: number): Value => ({ tag: "int", val: BigInt(n) });
const states = Array.from({ length: 12 }, (_, i) => ({
  count: v(i % 6),
  step_count: v(i % 6),
}));

const start = Date.now();
await runClient(BIN, SPEC, config, presetClient(states));
console.log(`OK (${Date.now() - start}ms)`);
