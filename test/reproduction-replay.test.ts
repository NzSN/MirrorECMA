import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  fileSha256,
  inspectProjectReproductionAuthority,
  loadProject,
  reproduceProject,
} from "../src/project.js";
import {
  decodeReproductionBundle,
  validateReproductionBundle,
} from "../src/reproduction-bundle.js";
import { frameworkForServer } from "./support/framework-selection.js";

const mirrors = resolve("../Mirrors/.lake/build/bin/mirror");
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mirrorecma-reproduction-project-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function prepareProject(options:{server?:string;frameworkRequired?:boolean}={}) {
  const sentinel = join(directory, "adapter-imported");
  const adapter = join(directory, "adapter.mjs");
  await writeFile(
    adapter,
    `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(sentinel)}, 'imported\\n');
export function createAdapter(){
  let pending=[],inFlight=0n,completed=new Set(),failed=false;
  return {actions:{
    Initialize:()=>{pending=[];inFlight=0n;completed=new Set();failed=false;},
    Enqueue:({Item})=>{pending.push(Item);},
    Start:()=>{inFlight=pending.shift();failed=false;},Fail:()=>{failed=true;},
    Retry:()=>{failed=false;},Complete:()=>{completed.add(inFlight);inFlight=0n;},
    Reset:()=>{pending=[];inFlight=0n;completed=new Set();failed=false;},
  },observe:()=>({Pending:pending,InFlight:inFlight,Completed:completed,Failed:failed}),dispose:()=>{}};
}
`,
  );
  const toolchain = {
    schema: "mirrorecma.toolchain/v1",
    tools: {
      server: {
        path: options.server??mirrors,
        sha256: await fileSha256(options.server??mirrors),
        version: "test-server",
        capabilities: ["model-interface-v1", "checked-replay-v1"],
      },
    },
  };
  await writeFile(
    join(directory, "mirror.toolchain.json"),
    JSON.stringify(toolchain),
  );
  const trace = resolve("examples/work-queue/artifacts/witness.itf.json");
  const modelModule = resolve(
    "examples/work-queue/artifacts/bundle/WorkQueue.suite.ts",
  );
  const project = {
    schema: "mirrorecma.project/v1",
    ...(options.frameworkRequired?{frameworkAdmission:"required"}:{}),
    suiteId: "work-queue.reproduction/v1",
    model: {
      source: resolve("examples/work-queue/specs/WorkQueue.tla"),
      contract: resolve(
        "examples/work-queue/artifacts/WorkQueue.mirror-interface.json",
      ),
      evidence: trace,
      lock: resolve(
        "examples/work-queue/artifacts/WorkQueue.mirror-interface.lock.json",
      ),
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
      traces: [
        { path: trace, sha256: await fileSha256(trace) },
        { path: trace, sha256: await fileSha256(trace) },
      ],
    },
    acceptance: {
      requiredActions: [
        "Complete",
        "Enqueue",
        "Fail",
        "Reset",
        "Retry",
        "Start",
      ],
      requiredPairs: [
        ["Enqueue", "Enqueue"],
        ["Fail", "Retry"],
      ],
    },
    execution: {
      mirror: { kind: "local" },
      timeouts: {
        registrationMs: 10_000,
        actionMs: 1_000,
        receiveMs: 10_000,
        cleanupMs: 1_000,
      },
    },
    toolchainLock: "mirror.toolchain.json",
  };
  const file = join(directory, "mirror.project.json");
  await writeFile(file, JSON.stringify(project));
  return { file, sentinel };
}

test("project authority binds actual model, corpus, interface, implementation, profile, and tool bytes before import", async () => {
  const { file, sentinel } = await prepareProject();
  const authority = await inspectProjectReproductionAuthority(file, {
    combinationId: "candidate.local-node-checked",
  });
  expect(authority.identities).toMatchObject({
    suite: { id: "work-queue.reproduction/v1" },
    corpus: { traceCount: 2 },
    generatedInterface: {
      semanticDigest:
        "3c646311c18341793bf7f09f0352b30c117fba8c424a0031e12bba4c77ebc2e2",
      targetProfile: "mirrorecma-async-v1",
    },
    executionProfile: { id: "candidate.local-node-checked" },
  });
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
},30_000);

test("identity refusal leaves the adapter unimported, while an exact bundle reproduces the mismatch", async () => {
  const { file, sentinel } = await prepareProject();
  const authority = await inspectProjectReproductionAuthority(file, {
    combinationId: "candidate.local-node-checked",
  });
  const fixture = JSON.parse(
    await readFile(
      resolve("test/fixtures/reproduction/accepted/behavioral-mismatch.json"),
      "utf8",
    ),
  );
  fixture.identities = authority.identities;
  const bundle = validateReproductionBundle(fixture);
  const options = {
    combinationId: "candidate.local-node-checked",
    catalogSelection: bundle.evidenceLinks.catalogSelectionRef,
    validateCatalogCombination: async (
      _selection: unknown,
      combinationId: string,
    ) => {
      expect(combinationId).toBe("candidate.local-node-checked");
    },
    validateEvidenceLinks: async () => {},
    admittedResolvers: new Set(["fixture-private-store/v1"]),
    resolveExternal: async () => "EXTERNAL_PRIVATE_CANARY",
  };
  const wrong = JSON.parse(JSON.stringify(bundle));
  wrong.identities.model.sourceClosureSha256 = "f".repeat(64);
  await expect(
    reproduceProject(
      file,
      decodeReproductionBundle(JSON.stringify(wrong)),
      options,
    ),
  ).rejects.toMatchObject({ code: "identity_mismatch" });
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  const replay = await reproduceProject(file, bundle, options);
  expect(replay.status).toBe("reproduced");
  expect(await readFile(sentinel, "utf8")).toBe("imported\n");
}, 60_000);

test("loaded required project cannot use generic inspect or reproduce callbacks without C5",async()=>{
  const {file,sentinel}=await prepareProject({frameworkRequired:true});
  const loaded=await loadProject(file);
  await expect(inspectProjectReproductionAuthority(loaded,{combinationId:"supported-local"})).rejects.toMatchObject({code:"catalog_selection_required"});
  const raw=await readFile(resolve("test/fixtures/reproduction/accepted/behavioral-mismatch.json"),"utf8");
  const bundle=decodeReproductionBundle(raw);
  await expect(reproduceProject(loaded,bundle,{combinationId:"supported-local",catalogSelection:bundle.evidenceLinks.catalogSelectionRef,validateCatalogCombination:()=>{},validateEvidenceLinks:()=>{},admittedResolvers:new Set(),resolveExternal:()=>new Uint8Array()})).rejects.toMatchObject({code:"catalog_selection_required"});
  await expect(readFile(sentinel)).rejects.toMatchObject({code:"ENOENT"});
});

test("filesystem identity mutation during external resolution is remeasured before effect",async()=>{
  const admitted=join(directory,"admitted-mirror");await writeFile(admitted,"#!/bin/sh\nexit 0\n");await chmod(admitted,0o700);
  const {file,sentinel}=await prepareProject({server:admitted,frameworkRequired:true});
  const framework=await frameworkForServer(admitted);
  const authority=await inspectProjectReproductionAuthority(file,{combinationId:framework.combinationId,framework});
  const fixture=JSON.parse(await readFile(resolve("test/fixtures/reproduction/accepted/behavioral-mismatch.json"),"utf8"));
  fixture.identities=authority.identities;fixture.evidenceLinks.catalogSelectionRef=framework.selectionRef;
  const bundle=validateReproductionBundle(fixture);
  await expect(reproduceProject(file,bundle,{combinationId:framework.combinationId,framework,catalogSelection:framework.selectionRef,validateCatalogCombination:()=>{},validateEvidenceLinks:()=>{},admittedResolvers:new Set(["fixture-private-store/v1"]),resolveExternal:async()=>{await appendFile(admitted,Buffer.from([0]));return "EXTERNAL_PRIVATE_CANARY";}})).rejects.toMatchObject({code:"executable_identity_mismatch"});
  await expect(readFile(sentinel)).rejects.toMatchObject({code:"ENOENT"});
},60_000);
