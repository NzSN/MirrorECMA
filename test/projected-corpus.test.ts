import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile, rm, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadProjectedCorpus, projectedCorpusDomainSize } from "../src/projected-corpus.js";
import { defineSuite, runSuite, type SuiteModel } from "../src/index.js";
import { ProjectedCellsModel } from "./fixtures/projected-corpus/bundle/ProjectedCells.suite.js";

const fixtures = resolve("test/fixtures/projected-corpus");
const generated = ProjectedCellsModel as SuiteModel & {provenanceDigest: string};
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const domain = (name: string, value: string) => hash(name + "\0" + value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
let root: string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"projected-corpus-unit-")); await cp(fixtures,root,{recursive:true});});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const readJson = async(path:string):Promise<any> => JSON.parse(await readFile(path,"utf8"));
function options(model = generated) {
  return {directory:join(root,"corpus"),lockPath:join(root,"ProjectedCells.lock.json"),sourceRoot:join(root,"source"),model,
    config:{specPath:join(root,"source/test/fixtures/model-interface/projected-cells/ProjectedCells.tla"),invariant:"Inv",lengthBound:6,paramVars:"parameters"}};
}
async function rewriteManifest(mutate:(manifest:any)=>void):Promise<typeof generated> {
  const path=join(root,"corpus/manifest.json"),manifest=await readJson(path);mutate(manifest);
  const bytes=canonical(manifest)+"\n";await writeFile(path,bytes);
  const lockPath=join(root,"ProjectedCells.lock.json"),lock=await readJson(lockPath);
  lock.provenance.workflow.corpusManifestSha256=hash(bytes);
  lock.provenanceDigest=domain("mirrors-model-interface-provenance/v1",canonical(lock.provenance));
  await writeFile(lockPath,canonical(lock)+"\n");
  return {...generated,provenanceDigest:lock.provenanceDigest};
}

test("compiler-generated corpus becomes one bound ordinary ReplayPlan",async()=>{
  let called=0;
  const result=await loadProjectedCorpus(options({...generated,bindLocal:()=>{called++;throw Error("not during admission");},bindPublicPort:()=>{called++;throw Error("not during admission");}}));
  expect(called).toBe(0);expect(result.replay.traces).toHaveLength(2);
  expect(result.identity).toMatchObject({schema:"mirrorecma.projected-corpus-identity/v1",memberCount:2,provenanceDigest:generated.provenanceDigest});
  const manifest=await readJson(join(root,"corpus/manifest.json"));
  expect(result.identity.manifestSha256).toBe(hash(await readFile(join(root,"corpus/manifest.json"))));
  expect(result.replay.provenance?.corpusDigest).toBe(manifest.corpusDigest);
  for(const [index,entry] of result.replay.traces.entries()) {
    expect(typeof entry).toBe("object");if(typeof entry==="string")throw Error("unbound path");
    expect(entry.sha256).toBe(hash(await readFile(entry.path)));
    expect(entry.sha256).not.toBe(manifest.members[index].outputSha256);
  }
  expect(Object.isFrozen(result.replay)).toBe(true);expect(Object.isFrozen(result.replay.traces)).toBe(true);
});

test.each(["duplicate-key","unknown-field","noncanonical-bytes"])("strict manifest rejects %s",async(kind)=>{
  const path=join(root,"corpus/manifest.json"),bytes=await readFile(path,"utf8");
  if(kind==="duplicate-key")await writeFile(path,bytes.replace('{','{"schema":"mirrors.model-interface-corpus/v1",'));
  else if(kind==="unknown-field"){const value=JSON.parse(bytes);value.extra=true;await writeFile(path,canonical(value)+"\n");}
  else await writeFile(path,bytes+" ");
  await expect(loadProjectedCorpus(options())).rejects.toMatchObject({code:"projected_corpus_invalid"});
});

test.each(["trace","receipt","projection"])("published %s byte tampering fails",async(kind)=>{
  const manifest=await readJson(join(root,"corpus/manifest.json"));
  const path=join(root,"corpus",kind==="projection"?"projection.json":manifest.members[0][kind].path);
  await writeFile(path,(await readFile(path,"utf8"))+" ");
  await expect(loadProjectedCorpus(options())).rejects.toThrow(/hash\/length|identity|admission/);
});

test.each(["extra","missing","symlink"])("exact ordinary file membership rejects %s",async(kind)=>{
  const manifest=await readJson(join(root,"corpus/manifest.json")),path=join(root,"corpus",manifest.members[0].trace.path);
  if(kind==="extra")await writeFile(join(root,"corpus/unowned.json"),"{}\n");
  if(kind==="missing")await rm(path);
  if(kind==="symlink"){await rm(path);await symlink(join(root,"corpus",manifest.members[1].trace.path),path);}
  await expect(loadProjectedCorpus(options())).rejects.toMatchObject({code:"projected_corpus_invalid"});
});

test("source bytes and generated workflow identity are both pinned",async()=>{
  await expect(loadProjectedCorpus(options({...generated,provenanceDigest:"a".repeat(64)}))).rejects.toThrow("trusted model provenance");
  await writeFile(options().config.specPath,readFileSync(options().config.specPath,"utf8")+"\n");
  await expect(loadProjectedCorpus(options())).rejects.toThrow("captured source changed");
});

test("compiler-normalized CRLF source identity remains valid",async()=>{
  const source=options().config.specPath;
  await writeFile(source,(await readFile(source,"utf8")).replace(/\n/g,"\r\n"));
  await expect(loadProjectedCorpus(options())).resolves.toMatchObject({identity:{memberCount:2}});
});

test("source BOM is preserved rather than silently removed during hashing",async()=>{
  const source=options().config.specPath;
  await writeFile(source,Buffer.concat([Buffer.from([239,187,191]),await readFile(source)]));
  await expect(loadProjectedCorpus(options())).rejects.toThrow("captured source changed");
});

test.each(["member-order","zero-raw","unsafe-path","corpus-digest"])("authenticated malformed manifest rejects %s",async(kind)=>{
  const model=await rewriteManifest(manifest=>{
    if(kind==="member-order")manifest.members.reverse();
    if(kind==="zero-raw")manifest.members[0].rawBytes=0;
    if(kind==="unsafe-path")manifest.members[0].trace.path="../outside.itf.json";
    if(kind==="corpus-digest")manifest.corpusDigest="0".repeat(64);
  });
  await expect(loadProjectedCorpus(options(model))).rejects.toMatchObject({code:"projected_corpus_invalid"});
});

test("mutation after loader admission is rechecked before transport/SUT acquisition",async()=>{
  const {replay}=await loadProjectedCorpus(options());
  const entry=replay.traces[0]!;if(typeof entry==="string")throw Error("expected bound file");
  await writeFile(entry.path,(await readFile(entry.path,"utf8"))+" ");
  let connections=0,implementations=0;
  const result=await runSuite(defineSuite({id:"tampered-after-load",model:generated,replay}),{
    mirror:()=>{connections++;throw Error("not permitted");},
    implementation:()=>{implementations++;throw Error("not permitted");},
  });
  expect(result).toMatchObject({outcome:"failed",conformance:"not_evaluated",failure:{stage:"configuration"}});
  expect(connections).toBe(0);expect(implementations).toBe(0);
});

test("artifact parser has its own bound above the network JSONL limit",async()=>{
  const path=join(root,"corpus/manifest.json");
  await writeFile(path,' '.repeat(16*1024*1024+1));
  await expect(loadProjectedCorpus(options())).rejects.toThrow("bounded ordinary file");
});

test("canonical integer domains retain arbitrary precision and bounded span",()=>{
  const huge="1"+"0".repeat(256);
  expect(projectedCorpusDomainSize(huge,huge)).toBe(1);
  expect(projectedCorpusDomainSize(huge,(BigInt(huge)+4095n).toString())).toBe(4096);
  for(const [low,high] of [["-0","0"],["01","1"],["1","0"],["0","4096"]])expect(()=>projectedCorpusDomainSize(low!,high!)).toThrow();
});
