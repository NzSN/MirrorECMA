import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { defineSuite, runSuite, decodeSemanticDescriptor, type SuiteModel, type ReplayPlan } from "../src/index.js";
import { preflightSuite, suiteSha256 } from "../src/suite-preflight.js";
import { specFromFiles } from "../src/spec.js";
import { CounterModelInterface, CounterPublicManifest, bindCounterAsyncPublicPort } from "./fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";

const lock = JSON.parse(readFileSync(resolve("test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json"), "utf8"));
const {contract: _contract, semanticDigest: _semantic, provenance: _provenance, provenanceDigest: _digest, ...fields} = lock;
const descriptor = decodeSemanticDescriptor({...fields, schema: "mirrors.model-interface-descriptor/v1"});
const rootLf = "---- MODULE Counter ----\nEXTENDS Helper\nVARIABLES count, parameters, action_taken\n====\n";
const helperLf = "---- MODULE Helper ----\nHelperValue == 1\n====\n";
const traceBytes = readFileSync(resolve("test/fixtures/model-interface/counter/counter.itf.json"));
const directories: string[] = [];
const MiB = 1024 * 1024;

async function fixture(root = rootLf, helper = helperLf) {
  const directory = await mkdtemp(join(tmpdir(), "workflow-preflight-"));
  directories.push(directory);
  const rootPath = join(directory, "Counter.tla"), helperPath = join(directory, "Helper.tla"), tracePath = join(directory, "trace.itf.json");
  await Promise.all([writeFile(rootPath, root), writeFile(helperPath, helper), writeFile(tracePath, traceBytes)]);
  const model: SuiteModel = {
    schema: "mirrors.suite-model/v1", nativeRepresentation: "mirrors.node-native/v1", semanticDigest: lock.semanticDigest,
    provenanceDigest: suiteSha256("reviewed workflow"), targetProfile: "mirrorecma-async-v1",
    stateComputerContractVersion: "mirrors.async-state-computer/v1", metadata: CounterModelInterface,
    descriptor, publicManifest: CounterPublicManifest, bindPublicPort: bindCounterAsyncPublicPort,
    bindLocal: () => { throw new Error("preflight must not bind implementation"); },
    provenance: {modelSha256: suiteSha256(rootLf), sources: [
      {module: "Counter", sha256: suiteSha256(rootLf)}, {module: "Helper", sha256: suiteSha256(helperLf)}]},
  };
  const replay: ReplayPlan = {kind: "corpus", modelSource: rootPath,
    config: {specPath: "/remote/Counter.tla", invariant: "TraceComplete", lengthBound: 6, constInit: "CInit", paramVars: "parameters"},
    traces: [{path: tracePath, sha256: suiteSha256(traceBytes)}],
    provenance: {interfaceDigest: lock.semanticDigest, modelSha256: suiteSha256(rootLf)},
  };
  const suite = (selectedModel = model, selectedReplay = replay) => defineSuite({id: "workflow-preflight", model: selectedModel, replay: selectedReplay});
  return {directory, rootPath, helperPath, tracePath, model, replay, suite};
}

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true}))); });

test.each(["\r\n", "\r"])("workflow preflight normalizes %j in root and imported source identity", async newline => {
  const value = await fixture(rootLf.replaceAll("\n", newline), helperLf.replaceAll("\n", newline));
  const result = await preflightSuite(value.suite());
  expect(result.modelDigest).toBe(suiteSha256(rootLf));
  expect(result.traceDigests).toEqual([suiteSha256(traceBytes)]);
  expect(result.actions).toEqual([["Initialize", "Tick", "Tick"]]);
});

test("ordinary suites retain raw source byte identity", async () => {
  const rawRoot = rootLf.replaceAll("\n", "\r\n"), rawHelper = helperLf.replaceAll("\n", "\r\n");
  const value = await fixture(rawRoot, rawHelper);
  const {provenanceDigest: _workflow, ...ordinary} = value.model;
  const model = {...ordinary, provenance: {modelSha256: suiteSha256(rawRoot), sources: [
    {module: "Counter", sha256: suiteSha256(rawRoot)}, {module: "Helper", sha256: suiteSha256(rawHelper)}]}};
  const replay = {...value.replay, provenance: {...value.replay.provenance!, modelSha256: suiteSha256(rawRoot)}};
  expect((await preflightSuite(value.suite(model, replay))).modelDigest).toBe(suiteSha256(rawRoot));
});

test("changed import after admission fails workflow source closure verification", async () => {
  const value = await fixture();
  await preflightSuite(value.suite());
  await writeFile(value.helperPath, helperLf.replace("== 1", "== 2"));
  await expect(preflightSuite(value.suite())).rejects.toThrow("source closure hash mismatch");
});

test("changed trace after admission fails before transport or implementation acquisition", async () => {
  const value = await fixture();
  await preflightSuite(value.suite());
  const changed = JSON.parse(traceBytes.toString("utf8")); changed.states[1].count = {"#bigint": "200"};
  await writeFile(value.tracePath, JSON.stringify(changed));
  let transportAcquisitions = 0, implementationAcquisitions = 0;
  const result = await runSuite(value.suite(), {
    mirror: () => { transportAcquisitions++; throw new Error("must not acquire transport"); },
    implementation: () => { implementationAcquisitions++; throw new Error("must not acquire implementation"); },
  });
  expect(result.failure?.kind).toBe("configuration");
  expect(transportAcquisitions).toBe(0); expect(implementationAcquisitions).toBe(0);
});

test.each(["root", "trace"])("workflow %s file bound rejects oversized files before parsing", async name => {
  const value = await fixture();
  const handle = await open(name === "root" ? value.rootPath : value.tracePath, "w");
  try { await handle.truncate(16 * MiB + 1); } finally { await handle.close(); }
  await expect(preflightSuite(value.suite())).rejects.toThrow("16 MiB limit");
});

test("one workflow byte budget covers captured sources and all trace occurrences", async () => {
  const value = await fixture();
  const padded = Buffer.from(traceBytes.toString("utf8").padEnd(2 * MiB, " "));
  await writeFile(value.tracePath, padded);
  const replay = {...value.replay, traces: Array.from({length: 32}, () => ({path: value.tracePath, sha256: suiteSha256(padded)}))};
  await expect(preflightSuite(value.suite(value.model, replay))).rejects.toThrow("aggregate byte limit");
}, 20_000);

test("workflow source reader rejects malformed UTF-8", async () => {
  const value = await fixture();
  await writeFile(value.rootPath, Buffer.concat([Buffer.from(rootLf), Buffer.from([0xff])]));
  await expect(preflightSuite(value.suite())).rejects.toThrow("valid UTF-8");
});

test("workflow trace reader rejects malformed UTF-8 with an otherwise current byte hash", async () => {
  const value = await fixture();
  const malformed = Buffer.concat([traceBytes, Buffer.from([0xff])]);
  await writeFile(value.tracePath, malformed);
  const replay = {...value.replay, traces: [{path: value.tracePath, sha256: suiteSha256(malformed)}]};
  await expect(preflightSuite(value.suite(value.model, replay))).rejects.toThrow("valid UTF-8");
});

test("source capture policy refuses extra modules before reading them and keeps default traversal", async () => {
  const value = await fixture();
  const reads: string[] = [];
  await expect(specFromFiles(value.rootPath, [], {maxSources: 1, readSource: async path => {
    reads.push(path); return rootLf;
  }})).rejects.toThrow("source closure exceeds 1 modules");
  expect(reads).toEqual([value.rootPath]);
  expect((await specFromFiles(value.rootPath, [])).sources).toEqual([rootLf, helperLf]);
});
