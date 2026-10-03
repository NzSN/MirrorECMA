import { specFromFiles } from "./spec.js";
import { readFile, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { validateDescriptorTraceState } from "./dynamic-binding.js";
import { decodeMirrorMessage } from "./protocol.js";
import { SuiteConfigurationError, type SuiteDefinition } from "./suite-definition.js";

export interface SuitePreflight {
  readonly modelDigest: string;
  readonly corpusDigest: string;
  readonly traceDigests: readonly string[];
  readonly stateCounts: readonly number[];
  readonly actions: readonly (readonly string[])[];
  readonly serverPaths: readonly string[];
}
export function suiteSha256(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
// Workflow artifacts use compiler source normalization and bounded reads all
// the way through admission. Ordinary suites keep their existing byte identity.
const workflowBounds = {fileBytes: 16 * 1024 * 1024, aggregateBytes: 64 * 1024 * 1024,
  sources: 256, traces: 32} as const;
interface WorkflowBudget { remaining: number }
async function readWorkflowFile(path: string, budget: WorkflowBudget): Promise<Buffer> {
  const reject = (message: string): never => { throw new SuiteConfigurationError(message); };
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) reject("workflow preflight requires an ordinary file");
  if (before.size > workflowBounds.fileBytes) reject("workflow preflight file exceeds 16 MiB limit");
  if (before.size > budget.remaining) reject("workflow preflight aggregate byte limit exceeded");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      reject("workflow preflight file changed before admission");
    }
    // One extra byte detects growth without allowing an unbounded readFile.
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs) {
      reject("workflow preflight file changed during admission");
    }
    budget.remaining -= length;
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
function workflowUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { throw new SuiteConfigurationError("workflow preflight requires valid UTF-8"); }
}

function validateRawItf(value: unknown, depth = 0): void {
  if (depth > 128) throw new SuiteConfigurationError("ITF nesting exceeds preflight limit");
  if (Array.isArray(value)) { value.forEach((item)=>validateRawItf(item,depth+1)); return; }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string,unknown>;
  const tags = ["#bigint","#set","#tup","#map","#unserializable"].filter((key)=>Object.hasOwn(record,key));
  if (tags.length === 1 && Object.keys(record).length === 1) {
    const tag=tags[0]!;
    if (tags.length !== 1 || Object.keys(record).length !== 1) throw new SuiteConfigurationError("ITF constructor has extra fields");
    const inner=record[tag];
    if (tag === "#bigint") {
      if (typeof inner !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(inner)) throw new SuiteConfigurationError("invalid ITF integer");
      return;
    }
    if (tag === "#unserializable") throw new SuiteConfigurationError("nonportable ITF value");
    if (!Array.isArray(inner)) throw new SuiteConfigurationError("ITF collection must contain an array");
    if (tag === "#map" && inner.some((entry)=>!Array.isArray(entry)||entry.length!==2)) throw new SuiteConfigurationError("invalid ITF map entry");
    inner.forEach((item)=>validateRawItf(item,depth+1));
    return;
  }
  Object.values(record).forEach((item)=>validateRawItf(item,depth+1));
}

/** Explicit I/O, before transport registration or implementation acquisition. */
export async function preflightSuite<Port>(suite: SuiteDefinition<Port>): Promise<SuitePreflight> {
  const fail = (message: string): never => { throw new SuiteConfigurationError(message); };
  const descriptor = suite.model.descriptor;
  const labels = new Map([...descriptor.initializers, ...descriptor.actions].flatMap((a) =>
    [a.wireAction, ...a.wireAliases].map((label) => [label, a] as const)));
  const workflowBudget: WorkflowBudget | undefined = suite.model.provenanceDigest === undefined ? undefined :
    {remaining: workflowBounds.aggregateBytes};
  const modelPath = suite.replay.modelSource ?? suite.replay.config.specPath;
  // Capture the workflow root exactly once, together with its bounded closure.
  // Compiler SourceUnit hashes normalized CRLF/lone-CR text, while traces keep
  // exact byte hashes (including any final LF).
  const workflowClosure = workflowBudget === undefined ? undefined : await specFromFiles(modelPath, undefined, {
    maxSources: workflowBounds.sources,
    readSource: async path => workflowUtf8(await readWorkflowFile(path, workflowBudget)).replace(/\r\n?/g, "\n"),
  });
  const modelDigest = workflowClosure === undefined ? suiteSha256(await readFile(modelPath)) :
    suiteSha256(workflowClosure.sources[0]!);
  if (suite.model.provenance?.modelSha256 !== undefined && suite.model.provenance.modelSha256 !== modelDigest) fail("bundle model source hash mismatch");
  if (suite.model.provenance?.sources !== undefined) {
    const closure = workflowClosure ?? await specFromFiles(modelPath);
    const actual = closure.sources.map(suiteSha256).sort();
    const expected = suite.model.provenance.sources.map((source)=>source.sha256).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("bundle source closure hash mismatch");
  }
  if (suite.replay.provenance?.modelSha256 !== undefined && suite.replay.provenance.modelSha256 !== modelDigest) fail("model provenance hash mismatch");
  const traceDigests: string[] = [];
  const stateCounts: number[] = [];
  const actions: string[][] = [];
  const serverPaths: string[] = [];
  const traceLimit = workflowBudget === undefined ? 4096 : workflowBounds.traces;
  if (suite.replay.traces.length > traceLimit) fail(`corpus exceeds ${traceLimit} trace occurrences`);
  for (const reference of suite.replay.traces) {
    const path = typeof reference === "string" ? reference : reference.path;
    const bytes = workflowBudget === undefined ? await readFile(path) : await readWorkflowFile(path, workflowBudget);
    const digest = suiteSha256(bytes);
    if (typeof reference !== "string" && reference.sha256 !== digest) fail("trace provenance hash mismatch");
    traceDigests.push(digest);
    serverPaths.push(typeof reference === "string" ? reference : reference.serverPath ?? reference.path);
    const trace: unknown = JSON.parse(workflowBudget === undefined ? bytes.toString("utf8") : workflowUtf8(bytes), (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isSafeInteger(value)) fail("ITF numbers must be safe integers or #bigint values");
      return value;
    });
    if (!trace || typeof trace !== "object" || !Array.isArray((trace as {states?:unknown}).states)) fail("ITF corpus must contain a states array");
    const stateParameters = (trace as {param_vars?:unknown}).param_vars ?? [];
    if (!Array.isArray(stateParameters) || stateParameters.some((name)=>typeof name !== "string") ||
        JSON.stringify([...stateParameters].sort()) !== JSON.stringify([...descriptor.runProfile.itfParamVars].sort())) fail("ITF parameter metadata disagrees with descriptor");
    const states = (trace as {states:unknown[]}).states;
    if (states.length < 1) fail("ITF trace must have an initialization");
    const ids: string[] = [];
    for (const [index, value] of states.entries()) {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("ITF state must be a record");
      const state = value as Record<string, unknown>;
      const wireAction = state[descriptor.runProfile.actionVariable];
      const action = typeof wireAction === "string" ? labels.get(wireAction) : undefined;
      if (!action || action.phase !== (index === 0 ? "initialize" : "transition")) fail("ITF action is unknown or has wrong phase");
      // The existing protocol codec validates complete ITF values; no state comparison is performed here.
      const plain = Object.fromEntries(Object.entries(state).filter(([name]) => !name.startsWith("#")));
      validateRawItf(plain);
      const decoded = decodeMirrorMessage(JSON.stringify({proto_step:"initial_state",action:wireAction,state:plain}));
      if (decoded.proto_step !== "initial_state") fail("invalid preflight state");
      validateDescriptorTraceState(descriptor, action!, (decoded as import("./protocol.js").InitialState).state);
      ids.push(action!.id);
    }
    stateCounts.push(states.length);
    actions.push(ids);
  }
  const corpusDigest = suiteSha256(JSON.stringify({schema:"mirrorecma.corpus/v1",traces:traceDigests}));
  if (suite.replay.provenance?.corpusDigest !== undefined && suite.replay.provenance.corpusDigest !== corpusDigest) fail("ordered corpus provenance mismatch");
  return Object.freeze({modelDigest,corpusDigest,traceDigests:Object.freeze(traceDigests),stateCounts:Object.freeze(stateCounts),actions:Object.freeze(actions.map((a) => Object.freeze(a))),serverPaths:Object.freeze(serverPaths)});
}
