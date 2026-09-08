import { strict as assert } from "node:assert";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
  CompiledAdapterRegistry,
  MIRRORECMA_ASYNC_TARGET_PROFILE,
  ReplayMismatchError,
  runClientWithTracesNegotiatedWithReport,
  semanticDigestFromHex,
  spawnMirror,
  type ApalacheConfig,
  type CompiledAdapterSelection,
  type LocalBinding,
  type ReplayReport,
  type Transport,
} from "../src/index.js";
import {
  bindCounter,
  CounterSemanticDigest as AsyncCounterSemanticDigest,
  type CounterBinding,
  type CounterPort,
} from "./fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";
import {
  CounterModelInterface, CounterSemanticDigest,
} from "./fixtures/model-interface/counter/generated/CounterMirror.generated.js";

const ecmaRoot = resolve(process.env.MIRRORECMA_ROOT ?? process.cwd());
const mirrorsRoot = resolve(process.env.MIRRORS_ROOT ?? join(ecmaRoot, "../Mirrors"));
const mirrorBinary = resolve(process.env.MIRROR_BIN ?? join(mirrorsRoot, ".lake/build/bin/mirror"));
const fixture = join(ecmaRoot, "test/fixtures/model-interface/counter");
const config: ApalacheConfig = {
  specPath: join(ecmaRoot, "examples/generated-counter/specs/Counter.tla"),
  invariant: "TraceComplete", lengthBound: 6, constInit: "CInit", paramVars: "parameters",
};

/** Observe authorization without changing the bytes delivered to the runner. */
class ObservedTransport implements Transport {
  matched = false;
  closes = 0;
  constructor(private readonly inner: Transport) {}
  send(line: string): void { this.inner.send(line); }
  async close(): Promise<number> { this.closes += 1; return this.inner.close(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for await (const line of this.inner) {
      const message: { proto_step?: string; modelInterface?: { status?: string } } = JSON.parse(line);
      if (message.proto_step === "spec_validated" && message.modelInterface?.status === "matched") {
        this.matched = true;
      }
      yield line;
    }
  }
}

async function runCase(broken: boolean): Promise<void> {
  const transport = new ObservedTransport(spawnMirror(mirrorBinary));
  const semanticDigest = semanticDigestFromHex(CounterSemanticDigest);
  const key = {
    semanticDigest, adapterId: "async-filesystem-counter/v1",
    targetProfile: MIRRORECMA_ASYNC_TARGET_PROFILE,
    stateComputerContractVersion: ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
  };
  let factoryCalls = 0;
  let disposeCalls = 0;
  let directory: string | undefined;
  let generated: CounterBinding | undefined;
  const registry = new CompiledAdapterRegistry([{
    key,
    factory: async (effective): Promise<LocalBinding> => {
      assert.equal(transport.matched, true, "SUT must only be constructed after a matched reply");
      factoryCalls += 1;
      directory = await mkdtemp(join(tmpdir(), "mirrorecma-async-counter-"));
      const stateFile = join(directory, "count.txt");
      const port: CounterPort = {
        initialize: async (context) => {
          await writeFile(stateFile, "0", { signal: context.signal });
        },
        tick: async ({ stride }, context) => {
          const current = BigInt(await readFile(stateFile, { encoding: "utf8", signal: context.signal }));
          const next = current + stride - (broken ? 1n : 0n);
          await writeFile(stateFile, next.toString(), { signal: context.signal });
        },
        observe: async (context) => ({
          count: BigInt(await readFile(stateFile, { encoding: "utf8", signal: context.signal })),
        }),
      };
      generated = bindCounter(port, effective);
      const binding = generated;
      return {
        semanticDigest, computer: binding.computer, coverage: binding.coverage,
        assertCompatibleConfig: (candidate) => assert.equal(candidate.paramVars, "parameters"),
        dispose: async () => {
          disposeCalls += 1;
          binding.dispose();
          await rm(directory!, { recursive: true, force: true });
        },
      };
    },
  }]);
  const selection: CompiledAdapterSelection = {
    mode: "compiled", metadata: CounterModelInterface, ...key, registry, policy: "require",
  };

  let report: ReplayReport | undefined;
  let failure: unknown;
  try {
    try {
      report = await runClientWithTracesNegotiatedWithReport(
        transport, config, [join(fixture, "counter.itf.json")], selection,
        { actionTimeoutMs: 5_000, receiveTimeoutMs: 30_000 },
      );
    } catch (error) { failure = error; }
    assert.equal(factoryCalls, 1, "one fresh filesystem SUT per matched session");
    assert.equal(disposeCalls, 1, "cleanup must run exactly once");
    assert.equal(transport.closes, 1, "transport must close exactly once");
    assert.ok(directory);
    await assert.rejects(access(directory), { code: "ENOENT" });
    if (broken) {
      assert.ok(failure instanceof ReplayMismatchError, `expected typed mismatch, got ${String(failure)}`);
      assert.equal(failure.traceIndex, 1);
      assert.equal(failure.stateIndex, 1);
      assert.equal(failure.action, "tick");
      assert.deepEqual(failure.params, {
        parameters: { tag: "record", val: { stride: { tag: "int", val: 2n } } },
      });
      assert.deepEqual(failure.expected.count, { tag: "int", val: 2n });
      assert.deepEqual(failure.actual.count, { tag: "int", val: 1n });
      assert.ok(failure.report);
      assert.equal(failure.report.status, "failed");
      assert.equal(failure.report.interfaceDigest, semanticDigest);
      assert.equal(failure.report.tracesCompleted, 0);
      assert.equal(failure.report.statesReported, 2);
      assert.equal(failure.report.statesMatched, 1);
      assert.equal(failure.report.stepsCompleted, 0);
      assert.deepEqual(failure.report.actionCounts, { init: 1, tick: 1 });
      assert.equal(JSON.parse(JSON.stringify(failure)).actual.count["#bigint"], "1");
      console.log("Async filesystem Counter faulty replay: typed mismatch at trace 1 state 1, expected 2, got 1.");
    } else {
      if (failure !== undefined) throw failure;
      assert.ok(report);
      assert.equal(report.status, "passed");
      assert.equal(report.interfaceDigest, semanticDigest);
      assert.equal(report.tracesStarted, 1);
      assert.equal(report.tracesCompleted, 1);
      assert.equal(report.statesReported, 3);
      assert.equal(report.statesMatched, 3);
      assert.equal(report.stepsCompleted, 2);
      assert.deepEqual(report.actionCounts, { init: 1, tick: 2 });
      assert.deepEqual(report.sequenceCounts, [
        { from: "init", to: "tick", count: 1 }, { from: "tick", to: "tick", count: 1 },
      ]);
      generated!.assertAllActionsCovered();
      console.log("Async filesystem Counter replay passed: 1 trace, 3 matched states, 2 transitions.");
    }
  } finally {
    // An early factory failure has not transferred ownership to the runner.
    // Successful and mismatched runs remove the store only through dispose().
    if (directory && disposeCalls === 0) await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const lock: { semanticDigest: string } = JSON.parse(await readFile(
    join(fixture, "Counter.mirror-interface.lock.json"), "utf8",
  ));
  assert.equal(lock.semanticDigest, CounterSemanticDigest);
  assert.equal(AsyncCounterSemanticDigest, CounterSemanticDigest,
    "sync and async emitter targets must use the same semantic identity");
  await runCase(false);
  await runCase(true);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
