import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  fileSha256,
  inspectProjectReproductionAuthority as projectLayerAuthority,
} from "../src/project.js";
import {
  inspectProjectReproductionAuthority,
  inspectProjectReproductionWithCatalog,
  validateReproductionBundle,
  encodeReproductionBundle,
} from "../src/index.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mirrorecma-authority-exports-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function prepareProject() {
  const server = resolve("../Mirrors/.lake/build/bin/mirror");
  const adapter = join(directory, "adapter.mjs");
  await writeFile(adapter, "export function createAdapter(){return {actions:{},observe:()=>({}),dispose:()=>{}};}\n");
  await writeFile(
    join(directory, "mirror.toolchain.json"),
    JSON.stringify({
      schema: "mirrorecma.toolchain/v1",
      tools: {
        server: {
          path: server,
          sha256: await fileSha256(server),
          version: "test-server",
          capabilities: ["model-interface-v1", "checked-replay-v1"],
        },
      },
    }),
  );
  const trace = resolve("examples/work-queue/artifacts/witness.itf.json");
  const modelModule = resolve("examples/work-queue/artifacts/bundle/WorkQueue.suite.ts");
  const project = {
    schema: "mirrorecma.project/v1",
    suiteId: "work-queue.authority-exports/v1",
    model: {
      source: resolve("examples/work-queue/specs/WorkQueue.tla"),
      contract: resolve("examples/work-queue/artifacts/WorkQueue.mirror-interface.json"),
      evidence: trace,
      lock: resolve("examples/work-queue/artifacts/WorkQueue.mirror-interface.lock.json"),
      target: "mirrorecma-async-v1",
      generatedDirectory: resolve("examples/work-queue/artifacts/bundle"),
      module: modelModule,
      export: "WorkQueueModel",
      moduleSha256: await fileSha256(modelModule),
    },
    implementation: { module: adapter, export: "createAdapter" },
    replay: {
      kind: "corpus",
      config: {
        specPath: resolve("examples/work-queue/specs/WorkQueue.tla"),
        initPredicate: "Init",
        nextPredicate: "WitnessNext",
        invariant: "TraceComplete",
        lengthBound: 15,
        paramVars: "parameters",
      },
      traces: [{ path: trace, sha256: await fileSha256(trace) }],
    },
    acceptance: { requiredActions: ["Enqueue"], requiredPairs: [["Enqueue", "Enqueue"]] },
    execution: {
      mirror: { kind: "local" },
      timeouts: { registrationMs: 10_000, actionMs: 1_000, receiveMs: 10_000, cleanupMs: 1_000 },
    },
    toolchainLock: "mirror.toolchain.json",
  };
  const file = join(directory, "mirror.project.json");
  await writeFile(file, JSON.stringify(project));
  return file;
}

test("package entry exports the reproduction authority and reports stable identities", async () => {
  expect(inspectProjectReproductionAuthority).toBe(projectLayerAuthority);
  expect(typeof inspectProjectReproductionWithCatalog).toBe("function");
  expect(typeof validateReproductionBundle).toBe("function");
  expect(typeof encodeReproductionBundle).toBe("function");
  const file = await prepareProject();
  const first = await inspectProjectReproductionAuthority(file, {
    combinationId: "candidate.local-node-checked",
  });
  const second = await inspectProjectReproductionAuthority(file, {
    combinationId: "candidate.local-node-checked",
  });
  expect(Object.keys(first.identities).sort()).toEqual([
    "corpus",
    "executionProfile",
    "generatedInterface",
    "implementation",
    "model",
    "suite",
  ]);
  expect(second.identities).toEqual(first.identities);
  expect(first.combinationId).toBe("candidate.local-node-checked");
});
