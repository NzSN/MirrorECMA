import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { resolve, join, sep, dirname } from "node:path";
import { decodeContractV1, decodeSemanticDescriptor, canonicalSemanticDescriptorString, semanticDescriptorDigest } from "./model-interface.js";
import { defineSuite, freezeSuiteData, type ReplayPlan, type SuiteModel } from "./suite-definition.js";
import { preflightSuite } from "./suite-preflight.js";
import type { ApalacheConfig } from "./protocol.js";

/** Artifact bounds are separate from (and never enlarge) the JSONL wire bound. */
export const PROJECTED_CORPUS_LIMITS = Object.freeze({ members: 32, fileBytes: 16 * 1024 * 1024,
  aggregateBytes: 64 * 1024 * 1024, nodes: 1_000_000, projectionWork: 1_000_000, sources: 256 });
export class ProjectedCorpusError extends Error {
  readonly code = "projected_corpus_invalid";
  constructor(message: string) { super(message); this.name = "ProjectedCorpusError"; }
}
type Obj = Record<string, unknown>;
interface Budget { bytes: number; nodes: number }
const fail: (message: string) => never = (message) => { throw new ProjectedCorpusError(message); };
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const domain = (name: string, bytes: string | Uint8Array): string => createHash("sha256").update(name).update("\0").update(bytes).digest("hex");
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) fail(`${label}: nonempty string expected`);
  return value as string;
}
function sha(value: unknown, label: string): string {
  const result = text(value, label); if (!/^[a-f0-9]{64}$/.test(result)) fail(`${label}: SHA-256 expected`); return result;
}
function nat(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail(`${label}: bounded integer expected`);
  return value as number;
}
function object(value: unknown, keys: readonly string[], required: readonly string[] = keys): Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("object expected");
  const record = value as Obj;
  if (Object.keys(record).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(record, key))) fail("unknown or missing artifact field");
  return record;
}
function array(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label}: bounded array expected`); return value as unknown[];
}
function sortedStrings(value: unknown, label: string): string[] {
  const items = array(value, 8192, label).map(item => text(item, label));
  if (items.some((item, i) => i > 0 && compare(items[i - 1]!, item) >= 0)) fail(`${label}: unique canonical order required`);
  return items;
}
function quote(value: string): string {
  return '"' + [...value].map(char => char === '"' ? '\\"' : char === '\\' ? '\\\\' : char === '\n' ? '\\n' :
    char === '\r' ? '\\r' : char.codePointAt(0)! < 32 ? `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}` : char).join("") + '"';
}
function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value as Obj).sort(compare).map(key => `${quote(key)}:${canonical((value as Obj)[key])}`).join(",")}}`;
  return fail("unsupported canonical artifact value");
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (canonical(actual) !== canonical(expected)) fail(`${label}: identity mismatch`);
}

class ArtifactJsonParser {
  private offset = 0;

  constructor(private readonly text: string, private readonly budget: Budget) {}

  parse(): unknown {
    const value = this.value(0);
    this.whitespace();
    if (this.offset !== this.text.length) this.syntax("trailing characters after JSON value");
    return value;
  }

  private syntax(message: string): never {
    fail(`JSON at offset ${this.offset}: ${message}`);
  }

  private whitespace(): void {
    while (this.offset < this.text.length && /[\t\n\r ]/.test(this.text[this.offset]!)) this.offset += 1;
  }

  private value(depth: number): unknown {
    if (--this.budget.nodes < 0) this.syntax("aggregate JSON node limit exceeded");
    this.whitespace();
    const char = this.text[this.offset];
    if (char === "{") return this.object(depth);
    if (char === "[") return this.array(depth);
    if (char === "\"") return this.string();
    if (char === "t") return this.literal("true", true);
    if (char === "f") return this.literal("false", false);
    if (char === "n") return this.literal("null", null);
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.number();
    return this.syntax("expected a JSON value");
  }

  private containerDepth(depth: number): number {
    if (depth >= 128) this.syntax(`JSON nesting exceeds ${128}`);
    return depth + 1;
  }

  private object(depth: number): Obj {
    const childDepth = this.containerDepth(depth);
    this.offset += 1;
    this.whitespace();
    const result: Obj = Object.create(null) as Obj;
    const keys = new Set<string>();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return result;
    }
    while (true) {
      this.whitespace();
      if (this.text[this.offset] !== "\"") this.syntax("expected an object key");
      const keyOffset = this.offset;
      const key = this.string();
      if (keys.has(key)) {
        this.offset = keyOffset;
        this.syntax(`duplicate object key '${key}'`);
      }
      keys.add(key);
      this.whitespace();
      if (this.text[this.offset] !== ":") this.syntax("expected ':' after object key");
      this.offset += 1;
      result[key] = this.value(childDepth);
      this.whitespace();
      const delimiter = this.text[this.offset];
      if (delimiter === "}") {
        this.offset += 1;
        return result;
      }
      if (delimiter !== ",") this.syntax("expected ',' or '}' after object member");
      this.offset += 1;
    }
  }

  private array(depth: number): unknown[] {
    const childDepth = this.containerDepth(depth);
    this.offset += 1;
    this.whitespace();
    const result: unknown[] = [];
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return result;
    }
    while (true) {
      result.push(this.value(childDepth));
      this.whitespace();
      const delimiter = this.text[this.offset];
      if (delimiter === "]") {
        this.offset += 1;
        return result;
      }
      if (delimiter !== ",") this.syntax("expected ',' or ']' after array element");
      this.offset += 1;
    }
  }

  private string(): string {
    this.offset += 1;
    let result = "";
    while (this.offset < this.text.length) {
      const char = this.text[this.offset++]!;
      if (char === "\"") return result;
      if (char === "\\") {
        const escaped = this.text[this.offset++];
        switch (escaped) {
          case "\"": result += "\""; break;
          case "\\": result += "\\"; break;
          case "/": result += "/"; break;
          case "b": result += "\b"; break;
          case "f": result += "\f"; break;
          case "n": result += "\n"; break;
          case "r": result += "\r"; break;
          case "t": result += "\t"; break;
          case "u": result += this.unicodeEscape(); break;
          default: return this.syntax("invalid string escape");
        }
      } else {
        const unit = char.charCodeAt(0);
        if (unit < 0x20) this.syntax("unescaped control character in string");
        if (unit >= 0xd800 && unit <= 0xdfff) {
          if (unit > 0xdbff || this.offset >= this.text.length) this.syntax("unpaired UTF-16 surrogate");
          const low = this.text.charCodeAt(this.offset);
          if (low < 0xdc00 || low > 0xdfff) this.syntax("unpaired UTF-16 surrogate");
          result += char + this.text[this.offset++]!;
        } else result += char;
      }
    }
    return this.syntax("unterminated string");
  }

  private unicodeEscape(): string {
    const first = this.hex4();
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.text.slice(this.offset, this.offset + 2) !== "\\u") this.syntax("high surrogate is not followed by a low surrogate");
      this.offset += 2;
      const second = this.hex4();
      if (second < 0xdc00 || second > 0xdfff) this.syntax("high surrogate is not followed by a low surrogate");
      return String.fromCodePoint(0x10000 + (first - 0xd800) * 0x400 + second - 0xdc00);
    }
    if (first >= 0xdc00 && first <= 0xdfff) this.syntax("unpaired low surrogate");
    return String.fromCodePoint(first);
  }

  private hex4(): number {
    const text = this.text.slice(this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(text)) this.syntax("incomplete Unicode escape");
    this.offset += 4;
    return Number.parseInt(text, 16);
  }

  private literal<T>(source: string, result: T): T {
    if (this.text.slice(this.offset, this.offset + source.length) !== source) this.syntax(`expected '${source}'`);
    this.offset += source.length;
    return result;
  }

  private number(): number {
    const rest = this.text.slice(this.offset);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (match === null) return this.syntax("invalid number");
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) this.syntax("number must be a safe integer");
    return value;
  }
}



function parse(bytes: Uint8Array, budget: Budget): unknown {
  let source: string;
  try { source = new TextDecoder("utf-8", {fatal: true}).decode(bytes); } catch { return fail("artifact must be UTF-8"); }
  return new ArtifactJsonParser(source, budget).parse();
}
function logicalPath(value: unknown): string {
  const name = text(value, "logical path");
  if (name.includes("\\") || name.includes(":") || name.startsWith("/") ||
      name.split("/").some(part => !part || part === "." || part === "..")) fail("invalid logical path");
  return name;
}
async function contained(root: string, name: string): Promise<string> {
  const relative = logicalPath(name);
  let current = root;
  for (const [index, part] of relative.split("/").entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < relative.split("/").length - 1 && !info.isDirectory())) fail("symlink or non-directory path component");
  }
  if (!current.startsWith(root + sep)) fail("artifact escaped its root");
  return current;
}
async function read(path: string, budget: Budget): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > PROJECTED_CORPUS_LIMITS.fileBytes) fail("bounded ordinary file required");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) fail("file changed during admission");
    // Read at most the admitted size plus one; a growing file cannot bypass bounds.
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const next = await handle.read(bytes, length, bytes.length - length, length);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs) fail("file changed while reading");
    budget.bytes -= length;
    if (budget.bytes < 0) fail("aggregate artifact byte limit exceeded");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
/** Pure artifact-domain check; exposed from this module for focused boundary tests. */
export function projectedCorpusDomainSize(lower: string, upper: string): number {
  if (!/^-?(0|[1-9][0-9]*)$/.test(lower) || !/^-?(0|[1-9][0-9]*)$/.test(upper) || lower === "-0" || upper === "-0") fail("invalid integer domain");
  const size = BigInt(upper) - BigInt(lower) + 1n;
  if (size < 1n || size > 4096n) fail("projection domain limit");
  return Number(size);
}
interface FileRef { path: string; sha256: string; bytes: number }
function fileRef(value: unknown): FileRef {
  const entry = object(value, ["path", "sha256", "bytes"]);
  const path = logicalPath(entry.path); if (path.includes("/")) fail("corpus members must be flat files");
  return { path, sha256: sha(entry.sha256, "file digest"), bytes: nat(entry.bytes, "file length", PROJECTED_CORPUS_LIMITS.fileBytes) };
}
async function readRef(root: string, ref: FileRef, budget: Budget): Promise<Buffer> {
  const bytes = await read(await contained(root, ref.path), budget);
  if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) fail("published file hash/length mismatch");
  return bytes;
}
function canonicalFile(bytes: Buffer, value: unknown): void {
  if (!bytes.equals(Buffer.from(canonical(value) + "\n"))) fail("artifact is not canonical JSON with exactly one LF");
}

export interface ProjectedCorpusOptions<Port> {
  readonly directory: string;
  readonly lockPath: string;
  /** Root under which the compiler's captured logical source paths resolve. */
  readonly sourceRoot: string;
  readonly model: SuiteModel<Port>;
  readonly config: ApalacheConfig;
  /** Explicit caller-owned remote path mapping; no path is received from a server. */
  readonly serverPath?: (relativeTracePath: string) => string;
}
export interface VerifiedProjectedCorpus {
  readonly replay: ReplayPlan;
  readonly identity: { readonly schema: "mirrorecma.projected-corpus-identity/v1";
    readonly manifestSha256: string; readonly lockFileSha256: string; readonly provenanceDigest: string;
    readonly interfaceDigest: string; readonly memberCount: number; readonly orderedTraceSha256: readonly string[] };
}

/** Verify compiler workflow artifacts before constructing a replay plan. This
 * never imports an implementation or invokes a generated binding. */
export async function loadProjectedCorpus<Port>(options: ProjectedCorpusOptions<Port>): Promise<VerifiedProjectedCorpus> {
  try { return await load(options); }
  catch (error) { if (error instanceof ProjectedCorpusError) throw error; throw new ProjectedCorpusError("projected corpus admission failed"); }
}

async function load<Port>(options: ProjectedCorpusOptions<Port>): Promise<VerifiedProjectedCorpus> {
  const budget: Budget = {bytes: PROJECTED_CORPUS_LIMITS.aggregateBytes, nodes: PROJECTED_CORPUS_LIMITS.nodes};
  const originalDirectory = resolve(options.directory), originalSources = resolve(options.sourceRoot);
  if ((await lstat(originalDirectory)).isSymbolicLink() || (await lstat(originalSources)).isSymbolicLink()) fail("roots must not be symlinks");
  const directory = await realpath(originalDirectory), sourceRoot = await realpath(originalSources);
  const manifestBytes = await read(await contained(directory, "manifest.json"), budget);
  const manifest = object(parse(manifestBytes, budget), ["schema", "rootModule", "sources", "sourceSha256", "plan", "members", "corpusDigest"]);
  if (manifest.schema !== "mirrors.model-interface-corpus/v1") fail("unsupported corpus schema");
  canonicalFile(manifestBytes, manifest);
  const manifestDigest = hash(manifestBytes);
  const lockBytes = await read(resolve(options.lockPath), budget);
  const lock = object(parse(lockBytes, budget), ["schema", "interfaceVersion", "model", "resolverSemanticsVersion", "comparisonPolicyVersion",
    "runProfile", "initializers", "actions", "observations", "contract", "semanticDigest", "provenance", "provenanceDigest"]);
  if (lock.schema !== "mirrors.model-interface-lock/v2") fail("projected corpus requires a reviewed workflow lock");
  canonicalFile(lockBytes, lock);
  const {schema: _schema, contract, semanticDigest, provenance, provenanceDigest, ...descriptorFields} = lock;
  const descriptor = decodeSemanticDescriptor({...descriptorFields, schema: "mirrors.model-interface-descriptor/v1"});
  if (semanticDescriptorDigest(descriptor) !== sha(semanticDigest, "semantic digest") || semanticDigest !== options.model.semanticDigest) fail("semantic identity mismatch");
  if (canonicalSemanticDescriptorString(descriptor) !== canonicalSemanticDescriptorString(options.model.descriptor)) fail("model descriptor mismatch");
  equal(decodeContractV1(contract), decodeContractV1(options.model.metadata.contract), "generated contract");
  const prov = object(provenance, ["compilerVersion", "contractSha256", "evidenceSha256", "sources", "workflow"]);
  text(prov.compilerVersion, "compiler version"); sha(prov.evidenceSha256, "evidence digest");
  if (domain("mirrors-model-interface-contract/v1", canonical(contract)) !== sha(prov.contractSha256, "contract digest")) fail("contract digest mismatch");
  if (domain("mirrors-model-interface-provenance/v1", canonical(prov)) !== sha(provenanceDigest, "provenance digest") ||
      provenanceDigest !== (options.model as SuiteModel<Port> & {provenanceDigest?: string}).provenanceDigest) fail("trusted model provenance mismatch");
  const workflow = object(prov.workflow, ["schema", "proposalSha256", "reviewSha256", "projectionPlanSha256", "members", "corpusManifestSha256"]);
  if (workflow.schema !== "mirrors.model-interface-workflow/v1") fail("unsupported workflow schema");
  sha(workflow.proposalSha256, "proposal digest"); sha(workflow.reviewSha256, "review digest");
  if (sha(workflow.corpusManifestSha256, "corpus manifest digest") !== manifestDigest) fail("corpus is not bound by the reviewed lock");
  const members = array(manifest.members, 32, "corpus members"), reviewed = array(workflow.members, 32, "workflow members");
  if (!members.length || members.length !== reviewed.length) fail("workflow/corpus membership mismatch");
  const sources = array(manifest.sources, PROJECTED_CORPUS_LIMITS.sources, "source closure").map(item => {
    const source = object(item, ["moduleName", "logicalPath", "contentSha256"]);
    return {module: text(source.moduleName, "source module"), path: logicalPath(source.logicalPath), sha256: sha(source.contentSha256, "source digest")};
  });
  if (!sources.length || sources.some((source, i) => i > 0 && compare(sources[i - 1]!.path, source.path) >= 0) ||
      new Set(sources.map(source => source.module)).size !== sources.length) fail("noncanonical or duplicate source closure");
  const lockSources = array(prov.sources, PROJECTED_CORPUS_LIMITS.sources, "lock sources").map(item => {
    const source = object(item, ["module", "path", "sha256"]);
    return {module: text(source.module, "source module"), path: logicalPath(source.path), sha256: sha(source.sha256, "source digest")};
  });
  if (lockSources.some((source, i) => i > 0 && compare(lockSources[i - 1]!.module, source.module) >= 0)) fail("noncanonical lock source closure");
  equal([...sources].sort((a,b) => compare(a.module,b.module)), lockSources, "complete source closure");
  equal([...sources].sort((a,b) => compare(a.module,b.module)).map(({module,sha256})=>({module,sha256})),
    [...(options.model.provenance?.sources ?? [])].sort((a,b)=>compare(a.module,b.module)), "generated source closure");
  const rootModule = text(manifest.rootModule, "root module"), root = sources.find(source => source.module === rootModule);
  if (!root || rootModule !== descriptor.model.module) fail("missing root source identity");
  if (decodeContractV1(contract).model.source !== root.path) fail("contract root source path mismatch");
  const modelSource = await contained(sourceRoot, root.path);
  let modelBytes: Buffer | undefined;
  for (const source of sources) {
    const path = source.module === rootModule ? modelSource : await contained(dirname(modelSource), source.path);
    const bytes = await read(path, budget);
    const normalized = Buffer.from(new TextDecoder("utf-8", {fatal:true,ignoreBOM:true}).decode(bytes).replace(/\r\n?/g,"\n"));
    if (hash(normalized) !== source.sha256) fail("captured source changed");
    if (source.module === rootModule) modelBytes = normalized;
  }
  if (!modelBytes || options.model.provenance?.modelSha256 !== root.sha256 ||
      domain("mirrors-trace-projection-source/v1", modelBytes) !== sha(manifest.sourceSha256, "projection source digest")) fail("root projection/source provenance mismatch");
  const planEntry = object(manifest.plan, ["path", "sha256", "bytes", "planSha256"]);
  const planRef = fileRef({path: planEntry.path, sha256: planEntry.sha256, bytes: planEntry.bytes});
  if (planRef.path !== "projection.json") fail("noncanonical plan path");
  const planBytes = await readRef(directory, planRef, budget), plan = object(parse(planBytes, budget), ["schema", "exactCopyVariables", "zipIntFunctions"]);
  canonicalFile(planBytes, plan);
  if (plan.schema !== "mirrors.model-interface-trace-projection/v1") fail("unsupported projection schema");
  const planDigest = domain("mirrors-trace-projection-plan/v1", canonical(plan));
  if (sha(planEntry.planSha256, "projection plan digest") !== planDigest || sha(workflow.projectionPlanSha256, "workflow plan") !== planDigest) fail("projection plan mismatch");
  const copied = sortedStrings(plan.exactCopyVariables, "copied variables");
  const groups = array(plan.zipIntFunctions, 32, "projection groups").map(item => {
    const group = object(item, ["outputWireName", "domain", "fields"]), bounds = object(group.domain, ["lowerInclusive", "upperInclusive"]);
    const low = text(bounds.lowerInclusive,"domain lower bound"), high = text(bounds.upperInclusive,"domain upper bound");
    const size = projectedCorpusDomainSize(low, high);
    const fields = array(group.fields,128,"projection fields").map(field => {const f=object(field,["name","sourceVariable"]); return {name:text(f.name,"field name"),source:text(f.sourceVariable,"source variable")};});
    if (!fields.length || fields.some((f,i)=>i>0&&compare(fields[i-1]!.name,f.name)>=0)) fail("noncanonical projection fields");
    return {name:text(group.outputWireName,"output variable"),size:Number(size),fields};
  });
  if (groups.some((g,i)=>i>0&&compare(groups[i-1]!.name,g.name)>=0)) fail("noncanonical projection groups");
  const inputVariables = [...copied,...groups.flatMap(g=>g.fields.map(f=>f.source))].sort(compare);
  const outputVariables = [...copied,...groups.map(g=>g.name)].sort(compare);
  if (new Set(inputVariables).size !== inputVariables.length || new Set(outputVariables).size !== outputVariables.length) fail("duplicate projection variable");
  const paths = ["manifest.json", "projection.json"], traces: {path:string;sha256:string;serverPath?:string}[] = [];
  let previous = "", rawBytes = manifestBytes.length + planBytes.length, work = 0;
  for (let index=0;index<members.length;index++) {
    const member = object(members[index], ["rawSha256","rawFileSha256","rawBytes","outputSha256","trace","receipt"]);
    const approved = object(reviewed[index], ["rawFileSha256","evidenceSha256","projection"]);
    const raw = sha(member.rawFileSha256,"raw file digest");
    if ((index>0 && compare(previous,raw)>=0) || sha(approved.rawFileSha256,"reviewed raw digest") !== raw) fail("member ordering or identity mismatch");
    previous=raw; sha(approved.evidenceSha256,"reviewed structural evidence");
    const rawSize = nat(member.rawBytes,"raw byte count",PROJECTED_CORPUS_LIMITS.fileBytes);
    if (rawSize === 0) fail("raw evidence file must be nonempty");
    rawBytes += rawSize;
    const projection = object(approved.projection,["outputSha256","evidenceSha256","fileSha256","receiptSha256"]);
    const traceRef = fileRef(member.trace), receiptRef = fileRef(member.receipt);
    if (traceRef.path !== raw+".itf.json" || receiptRef.path !== raw+".receipt.json") fail("member filename mismatch");
    paths.push(traceRef.path,receiptRef.path);
    const traceBytes = await readRef(directory,traceRef,budget), receiptBytes = await readRef(directory,receiptRef,budget);
    rawBytes += traceBytes.length+receiptBytes.length;
    if(rawBytes>PROJECTED_CORPUS_LIMITS.aggregateBytes) fail("aggregate corpus byte limit exceeded");
    const trace = object(parse(traceBytes,budget),["#meta","vars","states","params","param_vars"],["#meta","vars","states"]);
    const receipt = object(parse(receiptBytes,budget),["schema","sourceSha256","rawSha256","planSha256","outputSha256","inputVariables","outputVariables"]);
    canonicalFile(traceBytes,trace); canonicalFile(receiptBytes,receipt);
    if(receipt.schema!=="mirrors.model-interface-trace-projection-receipt/v1") fail("unsupported projection receipt");
    equal(receipt.sourceSha256,manifest.sourceSha256,"receipt source"); equal(receipt.planSha256,planDigest,"receipt plan");
    equal(sha(receipt.rawSha256,"receipt raw digest"),sha(member.rawSha256,"member raw digest"),"raw identity");
    const outputDigest=domain("mirrors-trace-projection-output/v1",canonical(trace));
    equal(sha(receipt.outputSha256,"receipt output"),outputDigest,"projected output");
    equal(sha(member.outputSha256,"member output"),outputDigest,"member projected output");
    equal(sha(projection.outputSha256,"workflow output"),outputDigest,"reviewed projected output");
    equal(sha(projection.fileSha256,"workflow file digest"),traceRef.sha256,"reviewed file identity");
    equal(sha(projection.receiptSha256,"workflow receipt digest"),domain("mirrors-trace-projection-receipt/v1",canonical(receipt)),"reviewed receipt identity");
    equal(sortedStrings(receipt.inputVariables,"receipt input variables"),inputVariables,"projection input variables");
    equal(sortedStrings(receipt.outputVariables,"receipt output variables"),outputVariables,"projection output variables");
    equal(sortedStrings(trace.vars,"trace variables"),outputVariables,"trace output variables");
    const meta=object(trace["#meta"],["format","format-description","description","varTypes"],["varTypes"]);
    const vars=object(meta.varTypes,outputVariables);
    for(const value of Object.values(vars)) text(value,"structural type evidence");
    const paramVars=trace.param_vars==null?[]:array(trace.param_vars,8192,"parameter variables").map(value=>text(value,"parameter variable")).sort(compare);
    if(new Set(paramVars).size!==paramVars.length) fail("duplicate parameter variable");
    const structural=domain("mirrors-model-interface-evidence/v1",canonical({itfParamVars:paramVars,traceVars:outputVariables,varTypes:vars}));
    equal(sha(projection.evidenceSha256,"projected structural evidence"),structural,"reviewed projected evidence");
    const states=array(trace.states,1_000_000,"trace states"); if(!states.length) fail("empty trace");
    work += states.length*(copied.length+groups.reduce((n,g)=>n+g.size*(1+g.fields.length),0));
    if(work>PROJECTED_CORPUS_LIMITS.projectionWork) fail("aggregate projection work limit exceeded");
    traces.push({path:join(directory,traceRef.path),sha256:traceRef.sha256,...(options.serverPath?{serverPath:text(options.serverPath(traceRef.path),"remote trace path")}: {})});
  }
  const actualPaths=(await readdir(directory)).sort(compare);
  equal(actualPaths,paths.sort(compare),"complete corpus file membership");
  const orderedTraceSha256=traces.map(trace=>trace.sha256),corpusDigest=hash(JSON.stringify({schema:"mirrorecma.corpus/v1",traces:orderedTraceSha256}));
  if(corpusDigest!==sha(manifest.corpusDigest,"ordered corpus digest")) fail("ordered corpus identity mismatch");
  const replay:ReplayPlan={kind:"corpus",config:options.config,modelSource,traces,
    provenance:{interfaceDigest:options.model.semanticDigest,modelSha256:root.sha256,corpusDigest}};
  await preflightSuite(defineSuite({id:"projected-corpus.preflight",model:options.model,replay}));
  // Detect replacements across linked verification and the existing preflight.
  equal(hash(await read(join(directory,"manifest.json"),budget)),manifestDigest,"manifest stability");
  return freezeSuiteData({replay,identity:{schema:"mirrorecma.projected-corpus-identity/v1",manifestSha256:manifestDigest,
    lockFileSha256:hash(lockBytes),provenanceDigest:provenanceDigest as string,interfaceDigest:options.model.semanticDigest,
    memberCount:members.length,orderedTraceSha256}});
}
