import { semanticDigestFromHex, type AsyncAdapterFactory } from "../../src/index.js";
import {
  bindCounterAsync,
  CounterSemanticDigest,
} from "../../test/fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";

/** Select the deliberate increment defect without allocating an implementation early. */
export function createLocalCounterFactory(broken = false): AsyncAdapterFactory {
  return async (config) => {
    let count = 0n;
    let disposed = false;
    const active = (): void => {
      if (disposed) throw new Error("Counter has been disposed");
    };
    const binding = bindCounterAsync({
      initialize: async () => { active(); count = 0n; },
      tick: async ({ stride }) => { active(); count += stride - (broken ? 1n : 0n); },
      observe: async () => { active(); return { count }; },
    }, config);
    return {
      ...binding,
      semanticDigest: semanticDigestFromHex(CounterSemanticDigest),
      dispose: () => { disposed = true; },
    };
  };
}
