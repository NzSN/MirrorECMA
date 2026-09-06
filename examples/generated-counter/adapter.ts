import {
  CompiledAdapterRegistry,
  MIRRORECMA_TARGET_PROFILE,
  STATE_COMPUTER_CONTRACT_VERSION,
  semanticDigestFromHex,
  type CompiledAdapterSelection,
  type LocalBinding,
} from "../../src/index.js";
import {
  bindCounter,
  CounterModelInterface,
  CounterSemanticDigest,
  type CounterBinding,
  type CounterPort,
} from "../../test/fixtures/model-interface/counter/generated/CounterMirror.generated.js";
import { Counter } from "./counter.js";

/** Create a selection and coverage accessors for one negotiated run. */
export function createCounterRun(
  createCounter: () => Counter = () => new Counter(),
): {
  selection: CompiledAdapterSelection;
  assertAllActionsCovered(): void;
  coverage(): Readonly<Record<string, number>>;
} {
  let binding: CounterBinding | undefined;
  const semanticDigest = semanticDigestFromHex(CounterSemanticDigest);
  const adapterId = "counter-example/v1";
  const key = {
    semanticDigest,
    adapterId,
    targetProfile: MIRRORECMA_TARGET_PROFILE,
    stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
  };
  const registry = new CompiledAdapterRegistry([{
    key,
    factory: (config): LocalBinding => {
      // The runner invokes this factory only after successful negotiation.
      const counter = createCounter();
      const port: CounterPort = {
        initialize: () => counter.reset(),
        tick: ({ stride }) => counter.increment(stride),
        observe: () => ({ count: counter.count }),
      };
      const generated = bindCounter(port, config);
      binding = generated;
      return {
        semanticDigest,
        computer: generated.computer,
        assertCompatibleConfig: (candidate) => {
          const parameterVariable = CounterModelInterface.contract.wire.parameterVariable;
          if (candidate.paramVars !== parameterVariable) {
            throw new Error(`Counter requires paramVars=${parameterVariable}`);
          }
        },
        coverage: generated.coverage,
        // The negotiated runner owns disposal. Counter holds no external resources.
        dispose: () => {},
      };
    },
  }]);

  function requireBinding(): CounterBinding {
    if (!binding) {
      throw new Error("Counter coverage is unavailable before a negotiated binding is created");
    }
    return binding;
  }

  return {
    selection: {
      mode: "compiled",
      metadata: CounterModelInterface,
      adapterId,
      targetProfile: MIRRORECMA_TARGET_PROFILE,
      stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
      registry,
      policy: "require",
    },
    assertAllActionsCovered: () => requireBinding().assertAllActionsCovered(),
    coverage: () => requireBinding().coverage(),
  };
}
