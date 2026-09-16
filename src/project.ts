/** Explicit development I/O. Importing this entry point never starts a run. */
import { spawn } from "node:child_process";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeContractV1, decodeSemanticDescriptor } from "./model-interface.js";
import { defineSuite, type SuiteModel, type SuitePublicManifest, type NativeSuiteAdapter } from "./suite-definition.js";
import { preflightSuite } from "./suite-preflight.js";
import { runSuite, type SuiteConstructionContext, type SuiteImplementation } from "./suite-runner.js";
import type { SuiteResult } from "./suite-result.js";
import { fileSha256, loadProject, ProjectError, readJson, record, type LoadedProject, type ProjectDeclaration, type ProjectLoadOptions, type ToolRole } from "./project-config.js";

export * from "./project-config.js";
export interface ProjectCommandOptions extends ProjectLoadOptions {
  readonly signal?: AbortSignal;
  readonly commandTimeoutMs?: number;
}
const defaults = { commandTimeoutMs: 120_000 };
async function tool(project: LoadedProject, role: ToolRole, args: string[], options: ProjectCommandOptions): Promise<void> {
  const identity=project.tools[role];
  if (!identity) throw new ProjectError("tool_missing",`${role} must be installed and pinned before this operation`);
  // Recheck identity immediately before spawning, including after an earlier command.
  if (await fileSha256(identity.path)!==identity.sha256) throw new ProjectError("tool_identity_mismatch",`${role} changed since discovery`);
  if (options.signal?.aborted) throw new ProjectError("cancelled","project operation cancelled");
  const timeoutMs=options.commandTimeoutMs??defaults.commandTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2_147_483_647) throw new ProjectError("configuration_invalid","command timeout must be a positive bounded duration");
  await new Promise<void>((done, reject) => {
    const child=spawn(identity.path,args,{cwd:project.directory,stdio:["ignore","pipe","pipe"],detached:process.platform!=="win32"});
    let bytes=0, output="", overflow=false, expired=false;
    let spawnError:unknown;
    const stop=()=>{
      try {if(process.platform!=="win32"&&child.pid!==undefined)process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}
      catch(cause){if(!(cause&&typeof cause==="object"&&"code"in cause&&cause.code==="ESRCH"))spawnError??=cause;}
    };
    const collect=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024){overflow=true;stop();}else output+=chunk.toString("utf8");};
    child.stdout.on("data",collect); child.stderr.on("data",collect);
    const timer=setTimeout(()=>{expired=true;stop();},timeoutMs);
    const abort=()=>stop();
    options.signal?.addEventListener("abort",abort,{once:true});
    if(options.signal?.aborted)abort();
    child.once("error",cause=>{spawnError=cause;});
    child.once("close",code=>{
      clearTimeout(timer);options.signal?.removeEventListener("abort",abort);
      if(options.signal?.aborted)reject(new ProjectError("cancelled","project operation cancelled after subprocess cleanup"));
      else if(spawnError!==undefined)reject(new ProjectError("tool_execution_failed",`${role} could not execute`,{cause:spawnError}));
      else if (code===0&&!overflow&&!expired) done();
      else reject(new ProjectError(expired?"tool_timed_out":overflow?"tool_output_limit":"tool_execution_failed",`${role} ${args[0]} failed${output?`: ${output.slice(0,4096)}`:""}`));
    });
  });
}
function compilerInputs(p:LoadedProject):string[] {
  const m=p.declaration.model;
  return ["--spec",m.source,"--contract",m.contract,"--evidence",m.evidence,"--param-var",p.replay.config.paramVars??"","--lock",m.lock];
}
async function asProject(value:LoadedProject|string|URL,options:ProjectLoadOptions):Promise<LoadedProject> {
  if(typeof value === "string" || value instanceof URL)return loadProject(value,options);
  if(options.installedRegistry!==undefined||Object.keys(options.tools??{}).length>0||
      (options.requiredTools??[]).some(role=>!(role==="server"&&value.declaration.execution.mirror.kind!=="local")&&!value.tools[role])) {
    return loadProject(value.file,{...options,installedRegistry:options.installedRegistry??value.installedRegistry,
      tools:{...Object.fromEntries(Object.entries(value.tools).map(([role,entry])=>[role,entry.path])),...options.tools}});
  }
  return value;
}
/** Verify compiler-owned files without importing either evaluator or adapter code. */
export async function verifyProjectBundle(project:LoadedProject):Promise<void> {
  const directory=project.declaration.model.generatedDirectory;
  const manifest=record(await readJson(join(directory,".suite-bundle-generated.json")),"bundle manifest",
    ["schema","profileVersion","targetProfile","semanticDigest","nativeRepresentation","metadataSha256","files","payloadSha256"]);
  if (manifest.schema!=="mirrors.suite-bundle/v1" || manifest.profileVersion!==1 || manifest.targetProfile!=="mirrorecma-async-v1" || manifest.nativeRepresentation!=="mirrors.node-native/v1") throw new ProjectError("schema_unsupported","unsupported suite bundle capability");
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.payloadSha256)) throw new ProjectError("bundle_invalid","invalid owned-file/hash manifest");
  const files=new Set<string>();
  for (const name of manifest.files) {
    if (typeof name!=="string" || !name || name.includes("\\") || name.includes("/") || name==="." || name===".." || name.includes("\0") || files.has(name)) throw new ProjectError("bundle_invalid","invalid or duplicate bundle filename");
    files.add(name);
    const info=await lstat(join(directory,name));
    if (!info.isFile() || info.isSymbolicLink()) throw new ProjectError("bundle_invalid","bundle payload must be a regular non-symlink file");
  }
  const hashes=new Set<string>();
  for (const value of manifest.payloadSha256) {
    const h=record(value,"bundle hash",["path","sha256"]);
    if(typeof h.path!=="string"||!files.has(h.path)||h.path===".suite-bundle-generated.json"||hashes.has(h.path)||typeof h.sha256!=="string"||!/^[a-f0-9]{64}$/.test(h.sha256)) throw new ProjectError("bundle_invalid","invalid payload hash entry");
    hashes.add(h.path);
    if(await fileSha256(join(directory,h.path))!==h.sha256) throw new ProjectError("bundle_stale",`bundle payload is stale: ${h.path}`);
  }
  if(!files.has(".suite-bundle-generated.json")||hashes.size!==files.size-1||!["descriptor.json","public-manifest.json","bundle-metadata.json"].every(f=>hashes.has(f))) throw new ProjectError("bundle_invalid","bundle hash inventory incomplete");
  if(await fileSha256(join(directory,"bundle-metadata.json"))!==manifest.metadataSha256) throw new ProjectError("bundle_stale","bundle metadata hash mismatch");
  const descriptor=decodeSemanticDescriptor(await readJson(join(directory,"descriptor.json")));
  const metadata=record(await readJson(join(directory,"bundle-metadata.json")),"bundle metadata",["schema","compilerVersion","provenanceDigest","semanticDigest","nativeRepresentation","targetProfile","stateComputerContractVersion","provenance"]);
  if(metadata.schema!=="mirrors.suite-bundle-metadata/v1"||metadata.semanticDigest!==manifest.semanticDigest||metadata.targetProfile!==manifest.targetProfile||metadata.nativeRepresentation!==manifest.nativeRepresentation||metadata.stateComputerContractVersion!=="mirrors.async-state-computer/v1") throw new ProjectError("bundle_invalid","bundle identity fields disagree");
  const contract=decodeContractV1(await readJson(project.declaration.model.contract));
  const unavailable=():never=>{throw new Error("inert check binding must never execute");};
  const lock=await readJson(project.declaration.model.lock) as Record<string,unknown>;
  if(lock.semanticDigest!==manifest.semanticDigest||lock.provenanceDigest!==metadata.provenanceDigest)throw new ProjectError("bundle_stale","bundle and semantic lock identities disagree");
  const model:SuiteModel={schema:"mirrors.suite-model/v1",nativeRepresentation:"mirrors.node-native/v1",semanticDigest:String(manifest.semanticDigest),targetProfile:"mirrorecma-async-v1",stateComputerContractVersion:"mirrors.async-state-computer/v1",descriptor,metadata:{semanticDigest:String(manifest.semanticDigest),contract},provenance:metadata.provenance as SuiteModel["provenance"],publicManifest:await readJson(join(directory,"public-manifest.json")) as SuitePublicManifest,bindLocal:unavailable,bindPublicPort:unavailable};
  // Identical validation and preflight semantics, without importing a generated module.
  await preflightSuite(defineSuite({id:project.suiteId,model,replay:project.replay,acceptance:project.acceptance}));
}
export async function checkProject(value:LoadedProject|string|URL,options:ProjectCommandOptions={}):Promise<LoadedProject> {
  const p=await asProject(value,{...options,requiredTools:["compiler"]});
  const m=p.declaration.model;
  await tool(p,"compiler",["check-bundle",...compilerInputs(p),"--target",m.target,"--out",m.generatedDirectory],options);
  for (const trace of p.replay.traces) await tool(p,"compiler",["preflight","--lock",m.lock,"--trace",typeof trace==="string"?trace:trace.path],options);
  await verifyProjectBundle(p);
  return p;
}
export async function generateProject(value:LoadedProject|string|URL,options:ProjectCommandOptions={}):Promise<LoadedProject> {
  const p=await asProject(value,{...options,requiredTools:["compiler"]});
  // resolve accepts sealed reviewed contracts; scaffold proposals have a different schema.
  decodeContractV1(await readJson(p.declaration.model.contract));
  await tool(p,"compiler",["resolve",...compilerInputs(p)],options);
  await tool(p,"compiler",["bundle","--lock",p.declaration.model.lock,"--target",p.declaration.model.target,"--out",p.declaration.model.generatedDirectory],options);
  return checkProject(p,options);
}
export interface ProjectReplayResult extends SuiteResult {
  readonly project: { readonly modelModuleSha256:string; readonly executableTrust:"evaluator-approved" };
}
export async function replayProject(value:LoadedProject|string|URL,options:ProjectCommandOptions={}):Promise<ProjectReplayResult> {
  const p=await asProject(value,{...options,requiredTools:["compiler","server"]});
  if(p.declaration.execution.mirror.kind==="local"&&!p.tools.server) throw new ProjectError("tool_missing","replay requires a pinned server");
  await checkProject(p,options);
  const modelModuleSha256=await fileSha256(p.declaration.model.module);
  if(p.declaration.model.moduleSha256!==undefined&&p.declaration.model.moduleSha256!==modelModuleSha256)throw new ProjectError("model_module_stale","prepared model module does not match its declared identity");
  const moduleUrl=pathToFileURL(p.declaration.model.module);moduleUrl.searchParams.set("sha256",modelModuleSha256);
  const namespace:Record<string,unknown>=await import(moduleUrl.href);
  const model=namespace[p.declaration.model.export] as SuiteModel<NativeSuiteAdapter>;
  if(!model) throw new ProjectError("model_export_missing","generated model export is unavailable; explicitly build the generated TypeScript companion");
  const suite=defineSuite({id:p.suiteId,model,replay:p.replay,acceptance:p.acceptance});
  const result=await runSuite(suite,{...p.execution,signal:options.signal,implementation:async(context:SuiteConstructionContext)=>{
    const implementation:Record<string,unknown>=await import(pathToFileURL(p.declaration.implementation.module).href);
    const factory=implementation[p.declaration.implementation.export];
    if(typeof factory!=="function") throw new ProjectError("adapter_export_missing","adapter factory export is unavailable");
    const adapter:NativeSuiteAdapter=await factory(context);
    const dispose=adapter!=null?context.deferCleanup(()=>adapter.dispose?.()):async()=>{};
    if(!adapter||typeof adapter.observe!=="function"||!adapter.actions) throw new ProjectError("adapter_shape_invalid","adapter requires actions and observe");
    const handle:SuiteImplementation<NativeSuiteAdapter>={port:adapter,dispose};
    return handle;
  }});
  // Preserve non-enumerable trusted raw evidence while adding observed executable identity.
  return Object.freeze(Object.defineProperty(Object.create(Object.getPrototypeOf(result),Object.getOwnPropertyDescriptors(result)),"project",{enumerable:true,value:Object.freeze({modelModuleSha256,executableTrust:"evaluator-approved"})})) as ProjectReplayResult;
}
export interface DoctorCheck { readonly check:string; readonly status:"passed"|"failed"|"not_checked"; readonly detail:string }
export async function doctorProject(file:string|URL,options:ProjectLoadOptions={}):Promise<readonly DoctorCheck[]> {
  try {
    const p=await loadProject(file,{...options,requiredTools:["compiler","server"],diagnose:true});
    const results:DoctorCheck[]=[{check:"configuration",status:"passed",detail:"project schema and declared settings validated"},
      ...p.toolChecks.map(c=>({check:`executable.${c.role}`,status:c.status,detail:c.message??"installed executable SHA-256 and execute permission verified against the trusted lock"})),
      ...p.packageChecks.map(c=>({check:`package.${c.name}`,status:c.status,detail:c.message??"installed package manifest name, version and SHA-256 verified; executable payloads are not authenticated by a manifest pin"}))];
    for(const check of p.toolChecks) if(check.status==="passed")results.push({check:`capabilities.${check.role}`,status:"not_checked",
      detail:"version and capability labels are trusted lock metadata; doctor does not execute this program or perform protocol admission"});
    if(p.declaration.execution.mirror.kind!=="local")results.push({check:"remote-server-capabilities",status:"not_checked",
      detail:"endpoint identity and capability labels are evaluator-approved metadata; replay still requires live model negotiation; no paths are uploaded"});
    try {await verifyProjectBundle(p);results.push({check:"bundle-and-corpus",status:"passed",detail:"owned artifact hashes and corpus preflight verified"});}
    catch {results.push({check:"bundle-and-corpus",status:"failed",detail:"artifacts missing, stale or invalid; run explicit generate/check with reviewed inputs"});}
    results.push({check:"namespace-admission",status:"not_checked",detail:"select the Gate backend probe separately"},{check:"hosted-agent-audit",status:"not_checked",detail:"Gate operator must verify its current approved hosting audit"});
    return Object.freeze(results);
  } catch(error) {
    return Object.freeze([{check:"configuration",status:"failed",detail:error instanceof ProjectError?error.message:"invalid project configuration"}]);
  }
}
/** Seed inert declarations only; init never creates a sealed model or checked corpus. */
export async function initProject(directory:string):Promise<readonly string[]> {
  const root=resolve(directory); await mkdir(root,{recursive:true});
  const declaration:ProjectDeclaration={schema:"mirrorecma.project/v1",suiteId:"example/v1",model:{source:"model/Example.tla",contract:"model/Example.mirror-interface.json",evidence:"traces/witness.itf.json",lock:".mirrors/Example.mirror-interface.lock.json",target:"mirrorecma-async-v1",generatedDirectory:".mirrors/evaluator",module:".mirrors/evaluator/Example.suite.js",export:"ExampleModel"},implementation:{module:"./adapter.mjs",export:"createAdapter"},replay:{kind:"corpus",config:{specPath:"model/Example.tla",initPredicate:"Init",nextPredicate:"Next",invariant:"Safety",lengthBound:20,paramVars:"parameters"},traces:["traces/witness.itf.json"]},acceptance:{requiredActions:[],requiredPairs:[]},execution:{mirror:{kind:"local"},timeouts:{registrationMs:60_000,actionMs:10_000,receiveMs:60_000,cleanupMs:10_000}},toolchainLock:"mirror.toolchain.json"};
  const files={"mirror.project.json":JSON.stringify(declaration,null,2)+"\n","mirror.toolchain.json":JSON.stringify({schema:"mirrorecma.toolchain/v1",tools:{},packages:{}},null,2)+"\n","MIRROR-SETUP.md":"# Next steps\n\nSelect your reviewed model, sealed contract, and checked corpus in mirror.project.json. Pin installed compiler/server paths, SHA-256, version and capabilities in mirror.toolchain.json. The compiler needs bundle-v1, check-bundle-v1 and preflight-v1; the server needs model-interface-v1 and checked-replay-v1. Optional package pins record packageJson, packageJsonSha256 and version for mirrorecma and the separate Gate packages. Optional apalache/java/gateRuntime executable pins remain distinct. Generate explicitly, compile the generated TypeScript during application preparation, and implement a real adapter. No expected-state observer or model is invented by init.\n"};
  const created:string[]=[];
  for(const [name,content] of Object.entries(files)) {
    let handle; try {handle=await open(join(root,name),"wx",0o600);await handle.writeFile(content);created.push(name);}
    catch(error) {if(!(error&&typeof error==="object"&&"code"in error&&error.code==="EEXIST"))throw error;}
    finally {await handle?.close();}
  }
  return Object.freeze(created);
}
export function suiteExitCode(result:SuiteResult):0|1|2 {
  return result.outcome==="passed"?0:result.outcome==="mismatch"&&result.cleanup.status==="succeeded"?1:2;
}
export type ProjectStage="configuration"|"toolchain"|"generation"|"check"|"replay";
/** Structured command boundary; unknown operational failures are never mislabeled configuration. */
export function projectFailure(error:unknown,stage:ProjectStage):{
  outcome:"failed"|"cancelled"|"timedOut";
  failure:{stage:ProjectStage;kind:"configuration"|"toolchain"|"cancellation"|"timeout"|"unknown";code:string;message:string};
} {
  const known=error instanceof ProjectError;
  const code=known?error.code:"project_operation_failed";
  const configuration=new Set(["usage","configuration_invalid","configuration_unavailable","schema_unsupported","corpus_invalid","remote_path_required"]);
  const toolchain=new Set(["tool_missing","tool_identity_mismatch","capability_unsupported","package_missing","package_identity_mismatch"]);
  const kind=code==="cancelled"?"cancellation":code==="tool_timed_out"?"timeout":configuration.has(code)?"configuration":
    toolchain.has(code)||code==="tool_execution_failed"||code==="tool_output_limit"?"toolchain":"unknown";
  return {outcome:kind==="cancellation"?"cancelled":kind==="timeout"?"timedOut":"failed",
    failure:{stage:configuration.has(code)?"configuration":toolchain.has(code)?"toolchain":stage,kind,code,
      message:known?error.message.slice(0,4096):"project operation failed"}};
}
