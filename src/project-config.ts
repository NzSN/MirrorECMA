import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMirror, connectTlsMirror, type TlsOptions, type Transport } from "./transport.js";
import { validateAcceptanceRequirements, type AcceptanceRequirements } from "./acceptance.js";
import type { ReplayPlan } from "./suite-definition.js";

export class ProjectError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "ProjectError";
  }
}
export type ToolRole = "compiler" | "server" | "apalache" | "java" | "gateRuntime";
export type PackageRole = "mirrorecma" | "mirrorgate" | "mirrorgate-mirrorecma";
export interface PackageIdentity {
  /** Installed package manifest; relative to the containing lock/registry file. */
  readonly packageJson: string;
  readonly packageJsonSha256: string;
  readonly version: string;
}
export interface ToolIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly version: string;
  readonly capabilities: readonly string[];
}
export interface ToolchainLock {
  readonly schema: "mirrorecma.toolchain/v1";
  readonly tools: Partial<Record<ToolRole, ToolIdentity>>;
  readonly packages?: Partial<Record<PackageRole, PackageIdentity>>;
}
export interface ProjectTimeouts {
  readonly registrationMs?: number;
  readonly actionMs?: number;
  readonly receiveMs?: number;
  readonly cleanupMs?: number;
}
export type ProjectEndpoint = { readonly kind: "local" } | {
  readonly kind: "tcp" | "tls";
  readonly host: string;
  readonly port: number;
  /** Evaluator-approved remote identity/capabilities; admission still happens over the protocol. */
  readonly serverIdentity: string;
  readonly capabilities: readonly string[];
  readonly tls?: TlsOptions;
};
export interface ProjectDeclaration {
  readonly schema: "mirrorecma.project/v1";
  readonly suiteId: string;
  readonly model: {
    readonly source: string;
    readonly contract: string;
    readonly evidence: string;
    readonly lock: string;
    readonly target: "mirrorecma-async-v1";
    readonly generatedDirectory: string;
    readonly module: string;
    readonly export: string;
    /** Optional evaluator-approved identity of the prepared executable module. */
    readonly moduleSha256?: string;
  };
  readonly implementation: { readonly module: string; readonly export: string };
  readonly replay: ReplayPlan;
  readonly acceptance: AcceptanceRequirements;
  readonly execution: { readonly mirror: ProjectEndpoint; readonly timeouts?: ProjectTimeouts };
  readonly toolchainLock: string;
}
export interface ProjectLoadOptions {
  /** Paths override a pinned entry, not its required hash or capabilities. */
  readonly tools?: Partial<Record<ToolRole, string>>;
  readonly installedRegistry?: string | URL;
  readonly requiredTools?: readonly ToolRole[];
  readonly diagnose?: boolean;
}
export interface ToolCheck {
  readonly role: ToolRole;
  readonly status: "passed" | "failed";
  readonly code?: string;
  readonly message?: string;
}
export interface PackageCheck {
  readonly name: PackageRole;
  readonly status: "passed" | "failed";
  readonly code?: string;
  readonly message?: string;
}
export interface LoadedProject {
  readonly file: string;
  readonly directory: string;
  readonly installedRegistry?: string;
  readonly declaration: ProjectDeclaration;
  readonly suiteId: string;
  readonly replay: ReplayPlan;
  readonly acceptance: AcceptanceRequirements;
  readonly tools: Readonly<Partial<Record<ToolRole, ToolIdentity>>>;
  readonly toolChecks: readonly ToolCheck[];
  readonly packages: Readonly<Partial<Record<PackageRole, PackageIdentity>>>;
  readonly packageChecks: readonly PackageCheck[];
  readonly execution: {
    readonly mirror: string | (() => Transport | Promise<Transport>);
    readonly timeouts: ProjectTimeouts;
  };
}
const roles: readonly ToolRole[] = ["compiler", "server", "apalache", "java", "gateRuntime"];
const packageRoles: readonly PackageRole[] = ["mirrorecma", "mirrorgate", "mirrorgate-mirrorecma"];
const capabilities: Partial<Record<ToolRole, readonly string[]>> = {
  compiler: ["bundle-v1", "check-bundle-v1", "preflight-v1"],
  server: ["model-interface-v1", "checked-replay-v1"],
};
export function record(value: unknown, label: string, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectError("configuration_invalid", `${label} must be an object`);
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(obj, k))) {
    throw new ProjectError("configuration_invalid", `${label} has missing or unknown fields`);
  }
  return obj;
}
function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new ProjectError("configuration_invalid", `${label} must be a nonempty string`);
}
function strings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 1024) throw new ProjectError("configuration_invalid", `${label} must be a bounded string array`);
  for (const item of value) nonempty(item, label);
  if (new Set(value).size !== value.length) throw new ProjectError("configuration_invalid", `${label} contains duplicates`);
}
export function immutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable)) as T;
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k,v]) => [k,immutable(v)]))) as T;
  return value;
}
export function parseProject(input: unknown): ProjectDeclaration {
  const p = record(input, "project", ["schema","suiteId","model","implementation","replay","acceptance","execution","toolchainLock"]);
  if (p.schema !== "mirrorecma.project/v1") throw new ProjectError("schema_unsupported", "unsupported project schema");
  nonempty(p.suiteId,"suiteId"); nonempty(p.toolchainLock,"toolchainLock");
  const modelFields=["source","contract","evidence","lock","target","generatedDirectory","module","export"];
  const model = record(p.model,"model",[...modelFields,"moduleSha256"],modelFields);
  for (const [key,value] of Object.entries(model)) nonempty(value,`model.${key}`);
  if(model.moduleSha256!==undefined) hash(model.moduleSha256,"model.moduleSha256");
  if (model.target !== "mirrorecma-async-v1") throw new ProjectError("capability_unsupported","project requires the compiled async target");
  const impl = record(p.implementation,"implementation",["module","export"]);
  nonempty(impl.module,"implementation.module"); nonempty(impl.export,"implementation.export");
  const replay = record(p.replay,"replay",["kind","config","traces","provenance","modelSource"],["kind","config","traces"]);
  if (replay.modelSource !== undefined) nonempty(replay.modelSource,"replay.modelSource");
  if (replay.kind !== "corpus" || !Array.isArray(replay.traces) || !replay.traces.length) throw new ProjectError("corpus_invalid","nonempty ordered corpus required");
  const config = record(replay.config,"replay.config",["specPath","initPredicate","nextPredicate","constInit","invariant","lengthBound","paramVars"],["specPath","invariant","lengthBound"]);
  nonempty(config.specPath,"replay.config.specPath"); nonempty(config.invariant,"replay.config.invariant");
  if (!Number.isSafeInteger(config.lengthBound) || (config.lengthBound as number)<0) throw new ProjectError("configuration_invalid","invalid length bound");
  for (const k of ["initPredicate","nextPredicate","constInit"]) if (config[k] !== undefined && config[k] !== null) nonempty(config[k],k);
  if (config.paramVars !== undefined && typeof config.paramVars !== "string") throw new ProjectError("configuration_invalid","paramVars must be a string");
  for (const trace of replay.traces) {
    if (typeof trace === "string") nonempty(trace,"trace");
    else {
      const t=record(trace,"trace",["path","sha256","serverPath"],["path","sha256"]);
      nonempty(t.path,"trace.path"); hash(t.sha256,"trace.sha256");
      if (t.serverPath !== undefined) nonempty(t.serverPath,"trace.serverPath");
    }
  }
  if (replay.provenance !== undefined) {
    const provenance=record(replay.provenance,"provenance",["interfaceDigest","modelSha256","corpusDigest"],["interfaceDigest"]);
    for (const [k,v] of Object.entries(provenance)) hash(v,k);
  }
  const acceptance=validateAcceptanceRequirements(p.acceptance as AcceptanceRequirements);
  const execution=record(p.execution,"execution",["mirror","timeouts"],["mirror"]);
  const endpoint=record(execution.mirror,"execution.mirror",["kind","host","port","serverIdentity","capabilities","tls"],["kind"]);
  if (endpoint.kind === "local") record(endpoint,"local endpoint",["kind"]);
  else if (endpoint.kind === "tcp" || endpoint.kind === "tls") {
    nonempty(endpoint.host,"host"); nonempty(endpoint.serverIdentity,"serverIdentity"); strings(endpoint.capabilities,"capabilities");
    if (!Number.isInteger(endpoint.port) || (endpoint.port as number)<1 || (endpoint.port as number)>65535) throw new ProjectError("configuration_invalid","invalid server port");
    for (const c of capabilities.server!) if (!endpoint.capabilities.includes(c)) throw new ProjectError("capability_unsupported",`remote server lacks ${c}`);
    if (endpoint.kind === "tls") {
      const tls=record(endpoint.tls,"tls",["caPath","certPath","keyPath","pin","servername","handshakeTimeoutMs"],["caPath","certPath","keyPath"]);
      for (const k of ["caPath","certPath","keyPath"]) nonempty(tls[k],k);
      if (tls.pin !== undefined) hash(tls.pin,"TLS pin");
      if (tls.servername !== undefined) nonempty(tls.servername,"servername");
      if (tls.handshakeTimeoutMs !== undefined) timeout(tls.handshakeTimeoutMs,"handshakeTimeoutMs");
    } else if (endpoint.tls !== undefined) throw new ProjectError("configuration_invalid","TCP endpoint cannot carry TLS settings");
    if ((replay.traces as unknown[]).some(t=>typeof t === "string" || !(t as Record<string,unknown>).serverPath)) throw new ProjectError("remote_path_required","remote replay requires explicit serverPath for each local checked trace; no implicit upload");
  } else throw new ProjectError("configuration_invalid","unsupported mirror endpoint");
  if (execution.timeouts !== undefined) {
    const t=record(execution.timeouts,"timeouts",["registrationMs","actionMs","receiveMs","cleanupMs"],[]);
    for (const [k,v] of Object.entries(t)) timeout(v,k);
  }
  return immutable({...p,acceptance} as unknown as ProjectDeclaration);
}
function hash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ProjectError("configuration_invalid",`${label} must be a lowercase SHA-256`);
}
function timeout(value: unknown,label: string): void {
  if (!Number.isSafeInteger(value) || (value as number)<=0 || (value as number)>2_147_483_647) throw new ProjectError("configuration_invalid",`${label} must be a positive bounded duration`);
}
export async function readJson(path: string): Promise<unknown> {
  try {
    const info=await stat(path); if (!info.isFile() || info.size>4*1024*1024) throw new ProjectError("configuration_invalid","JSON file must be regular and at most 4 MiB");
    return JSON.parse(await readFile(path,"utf8"));
  } catch (cause) {
    if (cause instanceof ProjectError) throw cause;
    throw new ProjectError("configuration_unavailable",`cannot read valid JSON: ${path}`,{cause});
  }
}
export async function fileSha256(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
export function parseToolchainLock(input: unknown): ToolchainLock {
  const lock=record(input,"toolchain",["schema","tools","packages"],["schema","tools"]);
  if (lock.schema !== "mirrorecma.toolchain/v1") throw new ProjectError("schema_unsupported","unsupported toolchain schema");
  const tools=record(lock.tools,"tools",roles,[]);
  for (const [role,value] of Object.entries(tools)) {
    const t=record(value,role,["path","sha256","version","capabilities"]);
    nonempty(t.path,`${role}.path`); hash(t.sha256,`${role}.sha256`); nonempty(t.version,`${role}.version`); strings(t.capabilities,`${role}.capabilities`);
  }
  if (lock.packages !== undefined) {
    const packages=record(lock.packages,"packages",packageRoles,[]);
    for (const [name,value] of Object.entries(packages)) {
      const entry=record(value,name,["packageJson","packageJsonSha256","version"]);
      nonempty(entry.packageJson,`${name}.packageJson`); hash(entry.packageJsonSha256,`${name}.packageJsonSha256`);
      nonempty(entry.version,`${name}.version`);
    }
  }
  return immutable(lock as unknown as ToolchainLock);
}
const localPath=(base:string,value:string)=>isAbsolute(value)?value:resolve(base,value);
export async function loadProject(file: string | URL, options: ProjectLoadOptions = {}): Promise<LoadedProject> {
  const filename=file instanceof URL?fileURLToPath(file):resolve(file), directory=dirname(filename);
  const p=parseProject(await readJson(filename));
  const lockPath=localPath(directory,p.toolchainLock);
  const lock=parseToolchainLock(await readJson(lockPath));
  const registryPath=options.installedRegistry instanceof URL?fileURLToPath(options.installedRegistry):options.installedRegistry?resolve(options.installedRegistry):undefined;
  const registry=registryPath?parseToolchainLock(await readJson(registryPath)):undefined;
  const tools: Partial<Record<ToolRole,ToolIdentity>>={}, checks: ToolCheck[]=[];
  const required=(options.requiredTools ?? ["server"]).filter(role=>role!=="server"||p.execution.mirror.kind==="local");
  if (options.tools) record(options.tools,"tool overrides",roles,[]);
  for (const role of roles) {
    const entry=lock.tools[role] ?? registry?.tools[role];
    if (!options.diagnose && !required.includes(role) && options.tools?.[role] === undefined) continue;
    if (!entry && !required.includes(role) && options.tools?.[role] === undefined) continue;
    try {
      if (!entry) throw new ProjectError("tool_missing",`install and pin ${role} before use`);
      const base=lock.tools[role]?dirname(lockPath):dirname(registryPath!);
      const selected=options.tools?.[role]===undefined?localPath(base,entry.path):resolve(options.tools[role]!);
      const canonical=await realpath(selected);
      await access(canonical,constants.X_OK);
      if (!(await stat(canonical)).isFile() || await fileSha256(canonical)!==entry.sha256) throw new ProjectError("tool_identity_mismatch",`${role} does not match its pinned content identity`);
      for (const capability of capabilities[role] ?? []) if (!entry.capabilities.includes(capability)) throw new ProjectError("capability_unsupported",`${role} lacks ${capability}`);
      tools[role]=immutable({...entry,path:canonical}); checks.push({role,status:"passed"});
    } catch (error) {
      const failure=error instanceof ProjectError?error:new ProjectError("tool_missing",`${role} executable is unavailable; prepare its pinned installation`);
      checks.push({role,status:"failed",code:failure.code,message:failure.message});
      if (!options.diagnose) throw failure;
    }
  }
  const packages:Partial<Record<PackageRole,PackageIdentity>>={}, packageChecks:PackageCheck[]=[];
  for (const name of packageRoles) {
    const entry=lock.packages?.[name]??registry?.packages?.[name];
    if (!entry) continue;
    try {
      const base=lock.packages?.[name]?dirname(lockPath):dirname(registryPath!);
      const packageJson=await realpath(localPath(base,entry.packageJson));
      const manifest=await readJson(packageJson) as Record<string,unknown>;
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.name!==name ||
          manifest.version!==entry.version || await fileSha256(packageJson)!==entry.packageJsonSha256) {
        throw new ProjectError("package_identity_mismatch",`${name} does not match its pinned manifest name, version and content identity`);
      }
      packages[name]=immutable({...entry,packageJson}); packageChecks.push({name,status:"passed"});
    } catch (error) {
      const failure=error instanceof ProjectError&&error.code==="package_identity_mismatch"?error:
        new ProjectError("package_missing",`${name} manifest is unavailable; explicitly prepare the pinned package installation`);
      packageChecks.push({name,status:"failed",code:failure.code,message:failure.message});
      if (!options.diagnose) throw failure;
    }
  }
  const model=Object.fromEntries(Object.entries(p.model).map(([k,v])=>[k,["target","export","moduleSha256"].includes(k)?v:localPath(directory,v)])) as unknown as ProjectDeclaration["model"];
  const endpoint=p.execution.mirror;
  const replay: ReplayPlan={...p.replay,modelSource:localPath(directory,p.replay.modelSource??p.model.source),config:{...p.replay.config,specPath:endpoint.kind==="local"?localPath(directory,p.replay.config.specPath):p.replay.config.specPath},
    traces:p.replay.traces.map(t=>typeof t==="string"?localPath(directory,t):{...t,path:localPath(directory,t.path)})};
  const declaration=immutable({...p,model,implementation:{...p.implementation,module:localPath(directory,p.implementation.module)},replay,toolchainLock:lockPath});
  let mirror: LoadedProject["execution"]["mirror"];
  if (endpoint.kind === "local") mirror=tools.server?.path ?? (()=>{throw new ProjectError("tool_missing","server is not available");});
  else {
    const remote=endpoint;
    mirror=()=>remote.kind==="tcp"?connectMirror(remote.host,remote.port):connectTlsMirror(remote.host,remote.port,{
      ...remote.tls!, caPath:localPath(directory,remote.tls!.caPath),certPath:localPath(directory,remote.tls!.certPath),keyPath:localPath(directory,remote.tls!.keyPath),
    });
  }
  return Object.freeze({file:filename,directory,...(registryPath===undefined?{}:{installedRegistry:registryPath}),declaration,suiteId:p.suiteId,replay:immutable(replay),acceptance:p.acceptance,tools:immutable(tools),toolChecks:immutable(checks),packages:immutable(packages),packageChecks:immutable(packageChecks),execution:Object.freeze({mirror,timeouts:p.execution.timeouts??Object.freeze({})})});
}
