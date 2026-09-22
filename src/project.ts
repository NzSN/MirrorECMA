/** Explicit development I/O. Importing this entry point never starts a run. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeContractV1, decodeSemanticDescriptor } from "./model-interface.js";
import { defineSuite, type SuiteModel, type SuitePublicManifest, type NativeSuiteAdapter } from "./suite-definition.js";
import { preflightSuite } from "./suite-preflight.js";
import { runSuite, type SuiteConstructionContext, type SuiteImplementation } from "./suite-runner.js";
import type { SuiteResult } from "./suite-result.js";
import {
  replayReproduction,
  type CatalogSelectionRef,
  type ExternalResolutionLimits,
  type ReproductionBundle,
  type ReproductionCaptureData,
  type ReproductionEvidenceLinks,
  type ReproductionIdentities,
  type ReproductionReplayResult,
  type SuiteNormalizationContext,
} from "./reproduction-bundle.js";
import {
  preflightFrameworkSelection,
  type CatalogSelectionRef as FrameworkCatalogSelectionRef,
  type FrameworkApprovalDecision,
  type FrameworkPreflightResult,
  type InstalledFrameworkObservation,
} from "./framework-catalog.js";
import { fileSha256, runtimeTreeIdentity, loadProject, parseProject, ProjectError, readJson, record, type LoadedProject, type ProjectDeclaration, type ProjectLoadOptions, type ToolRole, type PackageRole, type RuntimeTreeIdentity as MaterializedTreeIdentity } from "./project-config.js";

export * from "./project-config.js";
export interface ProjectCommandOptions extends ProjectLoadOptions {
  readonly signal?: AbortSignal;
  readonly commandTimeoutMs?: number;
  /** Explicit installed-distribution selection. Pure preflight runs before tools or imports. */
  readonly framework?: ProjectFrameworkSelection;
}
export interface ProjectFrameworkSelection {
  readonly catalogRaw: string;
  readonly selectionRef: FrameworkCatalogSelectionRef;
  readonly combinationId: string;
  readonly observed: InstalledFrameworkObservation;
  readonly approval?: FrameworkApprovalDecision;
  readonly installation: InstalledFrameworkBinding;
}
export interface InstalledFrameworkBinding {
  readonly schema: "mirrorecma.installed-framework-binding/v1";
  readonly executables: readonly Readonly<{
    role: string; artifactId: string; path: string; sha256: string;
  }>[];
  readonly packages: readonly Readonly<{
    packageId: string; componentId: string; artifactId: string;
    sourceSha256: string; root: string; tree: MaterializedTreeIdentity;
    manifest: Readonly<{path:string;sha256:string;version:string}>;
  }>[];
  readonly runtimeTrees: readonly Readonly<{
    runtimeId:string;treeId:string;root:string;sourceArtifactId:string;sourceSha256:string;
    materializedTree:MaterializedTreeIdentity;
  }>[];
}
const defaults = { commandTimeoutMs: 120_000 };
function preflightCommandFramework(
  options: ProjectCommandOptions,
): Extract<FrameworkPreflightResult, { status: "matched" }> | undefined {
  const input = options.framework;
  if (input === undefined) return undefined;
  const result = preflightFrameworkSelection(input.catalogRaw, {
    selectionRef: input.selectionRef,
    combinationId: input.combinationId,
    observed: input.observed,
    approval: input.approval,
  });
  if (result.status === "refused")
    throw new ProjectError(
      result.refusal.code,
      `framework selection refused at ${result.refusal.predicate}: ${result.refusal.detail}`,
    );
  return result;
}
function indexed<T>(values:readonly T[],key:(value:T)=>string,label:string):Map<string,T>{
  const result=new Map<string,T>();for(const value of values){const id=key(value);if(result.has(id))throw new ProjectError("framework_binding_invalid",`duplicate ${label} binding: ${id}`);result.set(id,value);}return result;
}
function sameTree(left:MaterializedTreeIdentity,right:MaterializedTreeIdentity):boolean{return left.algorithm===right.algorithm&&left.digest===right.digest&&left.entryCount===right.entryCount&&left.bytes===right.bytes;}
export async function verifyInstalledFrameworkBinding(
  framework:Extract<FrameworkPreflightResult,{status:"matched"}>|undefined,
  installation:InstalledFrameworkBinding|undefined,
  observed:InstalledFrameworkObservation|undefined,
  options:{readonly requireCurrentNode?:boolean}={},
):Promise<void>{
  if(framework===undefined)return;
  if(!installation||installation.schema!=="mirrorecma.installed-framework-binding/v1")throw new ProjectError("framework_binding_required","installed framework filesystem binding is required");
  const executableBindings=indexed(installation.executables,item=>item.role,"executable"),expectedExecutables=indexed(framework.executables,item=>item.role,"catalog executable");
  if(executableBindings.size!==expectedExecutables.size)throw new ProjectError("executable_identity_mismatch","installed executable binding denominator differs from catalog admission");
  for(const [role,expected] of expectedExecutables){const binding=executableBindings.get(role);if(!binding||binding.artifactId!==expected.artifactId||binding.sha256!==expected.sha256||await fileSha256(binding.path)!==expected.sha256)throw new ProjectError("executable_identity_mismatch",`actual installed executable differs: ${role}`);}
  const packageBindings=indexed(installation.packages,item=>item.packageId,"package"),expectedPackages=indexed(framework.packages,item=>item.packageId,"catalog package");
  if(packageBindings.size!==expectedPackages.size)throw new ProjectError("package_identity_mismatch","installed package binding denominator differs from catalog admission");
  for(const [packageId,expected] of expectedPackages){const binding=packageBindings.get(packageId);if(!binding||binding.componentId!==expected.componentId||binding.artifactId!==expected.artifactId||binding.sourceSha256!==expected.sha256||binding.manifest.version!==expected.version||await fileSha256(binding.manifest.path)!==binding.manifest.sha256||!sameTree(await runtimeTreeIdentity(binding.root),binding.tree))throw new ProjectError("package_identity_mismatch",`actual extracted package differs: ${packageId}`);const manifest=await readJson(binding.manifest.path) as Record<string,unknown>;if(manifest.name!==packageId||manifest.version!==binding.manifest.version)throw new ProjectError("package_identity_mismatch",`actual package manifest differs: ${packageId}`);}
  for(const [packageId,binding] of packageBindings){const admitted=framework.buildProvenance.trees.find(tree=>tree.inputId===`package:${packageId}`);if(!admitted||!sameTree(binding.tree,{algorithm:admitted.algorithm,digest:admitted.digest,entryCount:admitted.entryCount,bytes:admitted.bytes}))throw new ProjectError("package_identity_mismatch",`extracted package tree is not admitted: ${packageId}`);}
  const runtimeBindings=indexed(installation.runtimeTrees,item=>item.treeId,"runtime tree"),expectedTrees=indexed(framework.runtimeTrees,item=>item.treeId,"catalog runtime tree");
  if(runtimeBindings.size!==expectedTrees.size)throw new ProjectError("runtime_identity_mismatch","installed runtime binding denominator differs from catalog admission");
  const manifestRaw=observed?.distributionManifestRaw;
  const manifest=manifestRaw===undefined?undefined:JSON.parse(typeof manifestRaw==="string"?manifestRaw:new TextDecoder("utf-8",{fatal:true}).decode(manifestRaw)) as {artifacts?:{artifactId:string;sha256:string}[]};
  const policyRuntimes=indexed(observed?.policy.runtimeTrees??[],item=>item.treeId,"runtime policy");
  for(const [treeId,expected] of expectedTrees){const binding=runtimeBindings.get(treeId),policy=policyRuntimes.get(treeId),source=manifest?.artifacts?.find(item=>item.artifactId===expected.sourceArtifactId);if(!binding||!policy||binding.runtimeId!==policy.runtimeId||!source||binding.sourceArtifactId!==expected.sourceArtifactId||binding.sourceSha256!==source.sha256||binding.materializedTree.digest!==expected.digest||binding.materializedTree.entryCount!==expected.entryCount||binding.materializedTree.bytes!==expected.bytes||!sameTree(await runtimeTreeIdentity(binding.root),binding.materializedTree))throw new ProjectError("runtime_identity_mismatch",`actual materialized runtime differs: ${treeId}`);if(options.requireCurrentNode&&binding.runtimeId==="node-runtime"){const root=await realpath(binding.root),node=await realpath(process.execPath);if(node!==root&&!node.startsWith(`${root}/`))throw new ProjectError("runtime_identity_mismatch","current Node executable is outside the admitted runtime tree");}}
}
async function bindProjectFramework(
  project:LoadedProject,
  framework:Extract<FrameworkPreflightResult,{status:"matched"}>|undefined,
  installation:InstalledFrameworkBinding|undefined,
  observed:InstalledFrameworkObservation|undefined,
):Promise<void>{
  await verifyInstalledFrameworkBinding(framework,installation,observed,{requireCurrentNode:true});
  if(framework===undefined||installation===undefined)return;
  const executableBindings=indexed(installation.executables,item=>item.role,"executable");
  const toolRoles:Partial<Record<ToolRole,string>>={compiler:"model-interface-gen",server:"mirror-server"};
  for(const [toolRole,identity] of Object.entries(project.tools) as [ToolRole,NonNullable<LoadedProject["tools"][ToolRole]>][]){const admittedRole=toolRoles[toolRole];if(admittedRole===undefined)continue;const binding=executableBindings.get(admittedRole);if(!binding||identity.sha256!==binding.sha256||await fileSha256(identity.path)!==binding.sha256)throw new ProjectError("executable_identity_mismatch",`project-selected ${toolRole} differs from admitted ${admittedRole}`);}
  const packageBindings=indexed(installation.packages,item=>item.packageId,"package");
  for(const [packageId,binding] of packageBindings){const selected=project.packages[packageId as PackageRole];if(!selected||binding.manifest.sha256!==selected.packageJsonSha256||binding.manifest.version!==selected.version||await realpath(binding.manifest.path)!==await realpath(selected.packageJson))throw new ProjectError("package_identity_mismatch",`project-selected package differs: ${packageId}`);}
}
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
async function requireDeclaredFramework(
  value: LoadedProject | string | URL,
  options: ProjectCommandOptions,
): Promise<void> {
  if (options.framework !== undefined) return;
  const declaration =
    typeof value === "string" || value instanceof URL
      ? parseProject(
          await readJson(
            value instanceof URL ? value.pathname : resolve(value),
          ),
        )
      : value.declaration;
  if (declaration.frameworkAdmission === "required")
    throw new ProjectError(
      "catalog_selection_required",
      "this installed project requires --framework-input and --combination before tools or imports",
    );
}
async function declaredFrameworkRequired(value:LoadedProject|string|URL):Promise<boolean>{
  const declaration=typeof value==="string"||value instanceof URL
    ? parseProject(await readJson(value instanceof URL?value.pathname:resolve(value)))
    : value.declaration;
  return declaration.frameworkAdmission==="required";
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
  const lock=await readJson(project.declaration.model.lock) as Record<string,unknown>;
  const contract=decodeContractV1(lock.contract);
  const unavailable=():never=>{throw new Error("inert check binding must never execute");};
  if(lock.semanticDigest!==manifest.semanticDigest||lock.provenanceDigest!==metadata.provenanceDigest)throw new ProjectError("bundle_stale","bundle and semantic lock identities disagree");
  const model:SuiteModel={schema:"mirrors.suite-model/v1",nativeRepresentation:"mirrors.node-native/v1",semanticDigest:String(manifest.semanticDigest),targetProfile:"mirrorecma-async-v1",stateComputerContractVersion:"mirrors.async-state-computer/v1",descriptor,metadata:{semanticDigest:String(manifest.semanticDigest),contract},provenance:metadata.provenance as SuiteModel["provenance"],publicManifest:await readJson(join(directory,"public-manifest.json")) as SuitePublicManifest,bindLocal:unavailable,bindPublicPort:unavailable};
  // Identical validation and preflight semantics, without importing a generated module.
  await preflightSuite(defineSuite({id:project.suiteId,model,replay:project.replay,acceptance:project.acceptance}));
}
export async function checkProject(value:LoadedProject|string|URL,options:ProjectCommandOptions={}):Promise<LoadedProject> {
  await requireDeclaredFramework(value, options);
  const framework=preflightCommandFramework(options);
  const p=await asProject(value,{...options,requiredTools:["compiler"]});
  await bindProjectFramework(p,framework,options.framework?.installation,options.framework?.observed);
  const m=p.declaration.model;
  await tool(p,"compiler",["check-bundle",...compilerInputs(p),"--target",m.target,"--out",m.generatedDirectory],options);
  for (const trace of p.replay.traces) await tool(p,"compiler",["preflight","--lock",m.lock,"--trace",typeof trace==="string"?trace:trace.path],options);
  await verifyProjectBundle(p);
  await bindProjectFramework(p,framework,options.framework?.installation,options.framework?.observed);
  return p;
}
export async function generateProject(value:LoadedProject|string|URL,options:ProjectCommandOptions={}):Promise<LoadedProject> {
  await requireDeclaredFramework(value, options);
  const framework=preflightCommandFramework(options);
  const p=await asProject(value,{...options,requiredTools:["compiler"]});
  await bindProjectFramework(p,framework,options.framework?.installation,options.framework?.observed);
  // resolve accepts sealed reviewed contracts; scaffold proposals have a different schema.
  decodeContractV1(await readJson(p.declaration.model.contract));
  await tool(p,"compiler",["resolve",...compilerInputs(p)],options);
  await tool(p,"compiler",["bundle","--lock",p.declaration.model.lock,"--target",p.declaration.model.target,"--out",p.declaration.model.generatedDirectory],options);
  return checkProject(p,options);
}
export interface ProjectReplayResult extends SuiteResult {
  readonly project: { readonly modelModuleSha256:string; readonly executableTrust:"evaluator-approved" };
}
async function executePreparedProject(
  p: LoadedProject,
  options: ProjectCommandOptions,
  expected?: ReproductionIdentities,
): Promise<ProjectReplayResult> {
  if (p.declaration.execution.mirror.kind === "local" && !p.tools.server)
    throw new ProjectError("tool_missing", "replay requires a pinned server");
  if (
    p.tools.server &&
    (await fileSha256(p.tools.server.path)) !== p.tools.server.sha256
  )
    throw new ProjectError(
      "tool_identity_mismatch",
      "server changed since reproduction preflight",
    );
  const modelModuleSha256=await fileSha256(p.declaration.model.module);
  if (
    expected !== undefined &&
    expected.generatedInterface.moduleSha256 !== modelModuleSha256
  )
    throw new ProjectError(
      "model_module_stale",
      "prepared model module changed after reproduction preflight",
    );
  if(p.declaration.model.moduleSha256!==undefined&&p.declaration.model.moduleSha256!==modelModuleSha256)throw new ProjectError("model_module_stale","prepared model module does not match its declared identity");
  const moduleUrl=pathToFileURL(p.declaration.model.module);moduleUrl.searchParams.set("sha256",modelModuleSha256);
  const namespace:Record<string,unknown>=await import(moduleUrl.href);
  const model=namespace[p.declaration.model.export] as SuiteModel<NativeSuiteAdapter>;
  if(!model) throw new ProjectError("model_export_missing","generated model export is unavailable; explicitly build the generated TypeScript companion");
  const suite=defineSuite({id:p.suiteId,model,replay:p.replay,acceptance:p.acceptance});
  const result=await runSuite(suite,{...p.execution,signal:options.signal,implementation:async(context:SuiteConstructionContext)=>{
    if (
      expected !== undefined &&
      (await fileSha256(p.declaration.implementation.module)) !==
        expected.implementation.closureSha256
    )
      throw new ProjectError(
        "implementation_identity_mismatch",
        "implementation changed after reproduction preflight",
      );
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
export async function replayProject(value:LoadedProject|string|URL,options:ProjectCommandOptions={}):Promise<ProjectReplayResult> {
  await requireDeclaredFramework(value, options);
  const framework=preflightCommandFramework(options);
  const p=await asProject(value,{...options,requiredTools:["compiler","server"]});
  await bindProjectFramework(p,framework,options.framework?.installation,options.framework?.observed);
  if(p.declaration.execution.mirror.kind==="local"&&!p.tools.server) throw new ProjectError("tool_missing","replay requires a pinned server");
  if(framework===undefined)await checkProject(p,options);else await verifyProjectBundle(p);
  await bindProjectFramework(p,framework,options.framework?.installation,options.framework?.observed);
  return executePreparedProject(p, options);
}

function canonicalProjectIdentity(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalProjectIdentity).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalProjectIdentity((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function identitySha256(value: unknown): string {
  return createHash("sha256").update(canonicalProjectIdentity(value)).digest("hex");
}
async function regularFileSha256(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new ProjectError(
      "identity_unavailable",
      `${label} must be a regular non-symlink file`,
    );
  return fileSha256(path);
}
export interface ProjectReproductionAuthority {
  readonly project: LoadedProject;
  readonly identities: ReproductionIdentities;
  readonly combinationId: string;
}
export interface ProjectReproductionIdentityOptions extends ProjectCommandOptions {
  readonly combinationId: string;
  readonly frameworkBinding?: Extract<
    FrameworkPreflightResult,
    { status: "matched" }
  >;
  readonly frameworkInstallation?: InstalledFrameworkBinding;
  readonly frameworkObserved?: InstalledFrameworkObservation;
}
export async function inspectProjectReproductionAuthority(
  value: LoadedProject | string | URL,
  options: ProjectReproductionIdentityOptions,
): Promise<ProjectReproductionAuthority> {
  await requireDeclaredFramework(value,options);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.combinationId))
    throw new ProjectError(
      "configuration_invalid",
      "combinationId must be a stable identifier",
    );
  const commandFramework=preflightCommandFramework(options);
  const frameworkBinding=commandFramework??options.frameworkBinding;
  if(await declaredFrameworkRequired(value)&&commandFramework===undefined)throw new ProjectError("catalog_selection_required","required installed reproduction needs an actual catalog input and filesystem binding");
  const project = await asProject(value, {
    ...options,
    requiredTools: ["server"],
  });
  await bindProjectFramework(project,frameworkBinding,options.framework?.installation??options.frameworkInstallation,options.framework?.observed??options.frameworkObserved);
  await verifyProjectBundle(project);
  const metadata = record(
    await readJson(
      join(project.declaration.model.generatedDirectory, "bundle-metadata.json"),
    ),
    "bundle metadata",
    [
      "schema",
      "compilerVersion",
      "provenanceDigest",
      "semanticDigest",
      "nativeRepresentation",
      "targetProfile",
      "stateComputerContractVersion",
      "provenance",
    ],
  );
  const provenance = record(
    metadata.provenance,
    "bundle provenance",
    ["modelSha256", "sources"],
    ["modelSha256"],
  );
  const sources = Array.isArray(provenance.sources)
    ? provenance.sources.map((source) => {
        const item = record(source, "bundle source", ["module", "sha256"]);
        return { module: String(item.module), sha256: String(item.sha256) };
      })
    : [
        {
          module: "root",
          sha256: await regularFileSha256(
            project.replay.modelSource ?? project.declaration.model.source,
            "model source",
          ),
        },
      ];
  const modelClosureSha256 = identitySha256({
    schema: "mirrorecma.model-source-closure/v1",
    sources: [...sources].sort((left, right) =>
      left.module.localeCompare(right.module),
    ),
  });
  const traceDigests: string[] = [];
  for (const reference of project.replay.traces) {
    const path = typeof reference === "string" ? reference : reference.path;
    traceDigests.push(await regularFileSha256(path, "corpus trace"));
  }
  const corpusSha256 = identitySha256({
    schema: "mirrorecma.corpus/v1",
    traces: traceDigests,
  });
  const modelModuleSha256 = await regularFileSha256(
    project.declaration.model.module,
    "generated model module",
  );
  const implementationSha256 = await regularFileSha256(
    project.declaration.implementation.module,
    "implementation module",
  );
  const semanticDigest = String(metadata.semanticDigest);
  const suiteDefinitionSha256 = identitySha256({
    schema: "mirrorecma.suite-definition-identity/v1",
    id: project.suiteId,
    modelClosureSha256,
    corpusSha256,
    semanticDigest,
    replay: project.replay.config,
    acceptance: project.acceptance,
  });
  const selectedTools = Object.fromEntries(
    Object.entries(project.tools)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, tool]) => [
        role,
        tool === undefined
          ? null
          : {
              sha256: tool.sha256,
              capabilities: tool.capabilities,
            },
      ]),
  );
  const executionProfileSha256 = identitySha256({
    schema: "mirrorecma.execution-profile-identity/v1",
    combinationId: options.combinationId,
    execution: project.declaration.execution,
    tools: selectedTools,
    frameworkBinding,
  });
  const identities: ReproductionIdentities = Object.freeze({
    suite: {
      id: project.suiteId,
      definitionSha256: suiteDefinitionSha256,
    },
    model: { sourceClosureSha256: modelClosureSha256 },
    corpus: {
      orderedOccurrencesSha256: corpusSha256,
      traceCount: traceDigests.length,
    },
    generatedInterface: {
      semanticDigest,
      moduleSha256: modelModuleSha256,
      targetProfile: String(metadata.targetProfile),
      stateComputerContractVersion: String(
        metadata.stateComputerContractVersion,
      ),
    },
    implementation: {
      admissionId: `project.implementation/${project.declaration.implementation.export}`,
      closureSha256: implementationSha256,
    },
    executionProfile: {
      id: options.combinationId,
      sha256: executionProfileSha256,
    },
  });
  return Object.freeze({ project, identities, combinationId: options.combinationId });
}

export interface ReproduceProjectOptions extends ProjectReproductionIdentityOptions {
  readonly catalogSelection: CatalogSelectionRef;
  readonly validateCatalogCombination: (
    selection: CatalogSelectionRef,
    combinationId: string,
    project: LoadedProject,
  ) => void | Promise<void>;
  readonly validateEvidenceLinks: (
    links: ReproductionEvidenceLinks,
  ) => void | Promise<void>;
  readonly admittedResolvers: ReadonlySet<string>;
  readonly resolveExternal: (
    reference: Extract<ReproductionCaptureData, { kind: "external" }>,
    signal: AbortSignal,
  ) => Uint8Array | string | Promise<Uint8Array | string>;
  readonly externalLimits?: Partial<ExternalResolutionLimits>;
  readonly normalization?: SuiteNormalizationContext;
}
export async function reproduceProject(
  value: LoadedProject | string | URL,
  bundle: ReproductionBundle | string | Uint8Array,
  options: ReproduceProjectOptions,
): Promise<ReproductionReplayResult> {
  const authority = await inspectProjectReproductionAuthority(value, options);
  return replayReproduction(bundle, {
    expectedIdentities: authority.identities,
    expectedCatalogSelection: options.catalogSelection,
    validateEvidenceLinks: options.validateEvidenceLinks,
    admittedResolvers: options.admittedResolvers,
    resolveExternal: options.resolveExternal,
    externalLimits: options.externalLimits,
    signal: options.signal,
    normalization: options.normalization,
    validateCompatibility: () =>
      options.validateCatalogCombination(
        options.catalogSelection,
        options.combinationId,
        authority.project,
      ),
    evaluate: async () => {
      const framework=preflightCommandFramework(options);
      await bindProjectFramework(authority.project,framework??options.frameworkBinding,options.framework?.installation??options.frameworkInstallation,options.framework?.observed??options.frameworkObserved);
      return executePreparedProject(authority.project, options, authority.identities);
    },
  });
}

export interface CatalogProjectReproductionOptions
  extends Omit<
    ReproduceProjectOptions,
    "validateCatalogCombination" | "catalogSelection"
  > {
  readonly catalogSelection: FrameworkCatalogSelectionRef;
  readonly catalogRaw: string;
  readonly frameworkObserved: InstalledFrameworkObservation;
  readonly frameworkApproval?: FrameworkApprovalDecision;
  readonly installation: InstalledFrameworkBinding;
}
export interface CatalogProjectReproductionAuthority
  extends ProjectReproductionAuthority {
  readonly framework: Extract<FrameworkPreflightResult, { status: "matched" }>;
}
function matchedFrameworkSelection(
  options: CatalogProjectReproductionOptions,
): Extract<FrameworkPreflightResult, { status: "matched" }> {
  const result = preflightFrameworkSelection(options.catalogRaw, {
    selectionRef: options.catalogSelection,
    combinationId: options.combinationId,
    observed: options.frameworkObserved,
    approval: options.frameworkApproval,
  });
  if (result.status === "refused")
    throw new ProjectError(
      result.refusal.code,
      `framework selection refused: ${result.refusal.predicate}`,
    );
  return result;
}
export async function inspectProjectReproductionWithCatalog(
  value: LoadedProject | string | URL,
  options: CatalogProjectReproductionOptions,
): Promise<CatalogProjectReproductionAuthority> {
  const framework = matchedFrameworkSelection(options);
  const authority = await inspectProjectReproductionAuthority(value, {
    ...options,
    framework:{catalogRaw:options.catalogRaw,selectionRef:options.catalogSelection,combinationId:options.combinationId,observed:options.frameworkObserved,approval:options.frameworkApproval,installation:options.installation},
    frameworkBinding: framework,
    frameworkInstallation: options.installation,
    frameworkObserved: options.frameworkObserved,
  });
  return Object.freeze({ ...authority, framework });
}
export async function reproduceProjectWithCatalog(
  value: LoadedProject | string | URL,
  bundle: ReproductionBundle | string | Uint8Array,
  options: CatalogProjectReproductionOptions,
): Promise<ReproductionReplayResult> {
  const framework = matchedFrameworkSelection(options);
  return reproduceProject(value, bundle, {
    ...options,
    framework:{catalogRaw:options.catalogRaw,selectionRef:options.catalogSelection,combinationId:options.combinationId,observed:options.frameworkObserved,approval:options.frameworkApproval,installation:options.installation},
    frameworkBinding: framework,
    frameworkInstallation: options.installation,
    frameworkObserved: options.frameworkObserved,
    validateCatalogCombination: (selection, combinationId) => {
      if (
        selection.selectionValue !==
          framework.catalogSelectionRef.selectionValue ||
        combinationId !== framework.combinationId
      )
        throw new ProjectError(
          "catalog_selection_mismatch",
          "framework selection changed after preflight",
        );
    },
  });
}
export interface DoctorCheck { readonly check:string; readonly status:"passed"|"failed"|"not_checked"; readonly detail:string }
export async function doctorProject(file:string|URL,options:ProjectCommandOptions={}):Promise<readonly DoctorCheck[]> {
  try {
    await requireDeclaredFramework(file, options);
  } catch(error) {
    return Object.freeze([
      {check:"catalog.selection",status:"failed",detail:error instanceof ProjectError?error.message:"catalog selection required"},
      {check:"configuration",status:"not_checked",detail:"project configuration was not inspected after missing required catalog selection"},
    ]);
  }
  let framework: Extract<FrameworkPreflightResult, {status:"matched"}>|undefined;
  try {
    framework=preflightCommandFramework(options);
  } catch(error) {
    return Object.freeze([
      {check:"catalog.selection",status:"failed",detail:error instanceof ProjectError?error.message:"invalid framework selection"},
      {check:"configuration",status:"not_checked",detail:"project configuration was not inspected after catalog refusal"},
    ]);
  }
  try {
    const p=await loadProject(file,{...options,requiredTools:["compiler","server"],diagnose:true});
    const results:DoctorCheck[]=[
      ...(framework===undefined?[{check:"catalog.selection",status:"not_checked" as const,detail:"no explicit installed framework selection was supplied"}]:[
        {check:"catalog.selection",status:"passed" as const,detail:`${framework.catalogSelectionRef.selectionKind}:${framework.catalogSelectionRef.selectionValue}`},
        {check:"catalog.combination",status:"passed" as const,detail:`${framework.combinationId} (${framework.catalogState}, ${framework.admission})`},
        ...framework.componentRefs.map(component=>({check:`catalog.component.${component.componentId}`,status:"passed" as const,detail:`${component.repository}@${component.revision}${component.dirty?" dirty":" clean"}`})),
        ...framework.packages.map(pkg=>({check:`catalog.package.${pkg.packageId}`,status:"passed" as const,detail:`${pkg.version} ${pkg.sha256}`})),
        ...framework.executables.map(executable=>({check:`catalog.executable.${executable.role}`,status:"passed" as const,detail:`${executable.sha256}; capabilities=${executable.capabilityIds.join(",")}`})),
        ...framework.runtimeTrees.map(tree=>({check:`catalog.runtime-tree.${tree.treeId}`,status:"passed" as const,detail:`${tree.algorithm}:${tree.digest}; entries=${tree.entryCount}; bytes=${tree.bytes}`})),
        {check:"catalog.platform",status:"passed" as const,detail:`${framework.platform.os}/${framework.platform.architecture}/${framework.platform.osRelease}${framework.platform.backend?` backend=${framework.platform.backend}`:""}`},
      ]),
      {check:"configuration",status:"passed",detail:"project schema and declared settings validated"},
      ...p.toolChecks.map(c=>({check:`executable.${c.role}`,status:c.status,detail:c.message??"installed executable SHA-256 and execute permission verified against the trusted lock"})),
      ...p.packageChecks.map(c=>({check:`package.${c.name}`,status:c.status,detail:c.message??"installed package manifest name, version and SHA-256 verified; executable payloads are not authenticated by a manifest pin"}))];
    try {
      await bindProjectFramework(p,framework,options.framework?.installation,options.framework?.observed);
      if(framework!==undefined)results.push({check:"catalog.filesystem-binding",status:"passed",detail:"selected executable bytes, extracted package trees/manifests, and runtime trees match catalog admission"});
    } catch(error) {
      results.push({check:"catalog.filesystem-binding",status:"failed",detail:error instanceof ProjectError?error.message:"installed filesystem binding failed"});
      return Object.freeze(results);
    }
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
export type ProjectStage="configuration"|"toolchain"|"generation"|"check"|"replay"|"reproduction";
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
