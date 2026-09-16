import type { ApalacheConfig } from "./protocol.js";
import type { AsyncLocalBinding } from "./adapter-registry.js";
import type { ReplayContext } from "./async-replay.js";
import {
  decodeContractV1, decodeSemanticDescriptor, semanticDescriptorDigest,
  type GeneratedModelInterface, type ModelType, type SemanticDescriptor,
} from "./model-interface.js";
import { validateAcceptanceRequirements, type AcceptanceRequirements } from "./acceptance.js";

export interface SuitePublicManifest {
  readonly schema: "mirrorgate.port/v1";
  readonly interfaceDigest: string;
  readonly initializers: readonly { readonly id: string; readonly inputs: readonly { readonly id: string; readonly type: ModelType }[] }[];
  readonly actions: readonly { readonly id: string; readonly inputs: readonly { readonly id: string; readonly type: ModelType }[] }[];
  readonly observations: readonly { readonly id: string; readonly type: ModelType }[];
}
export interface SuitePublicPort {
  invoke(operationId: string, inputs: Readonly<Record<string, unknown>>, context: ReplayContext): Promise<void>;
  observe(context: ReplayContext): Promise<Readonly<Record<string, unknown>>>;
}
export interface NativeSuiteAdapter {
  readonly actions: Readonly<Record<string, (inputs: Readonly<Record<string, unknown>>, context: ReplayContext) => void | Promise<void>>>;
  observe(context: ReplayContext): Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
  dispose?(): void | Promise<void>;
}
export type SuiteBinding = Pick<AsyncLocalBinding, "computer" | "assertCompatibleConfig" | "coverage">;
export interface SuiteModel<Port = NativeSuiteAdapter> {
  readonly schema: "mirrors.suite-model/v1";
  readonly nativeRepresentation: "mirrors.node-native/v1";
  readonly semanticDigest: string;
  readonly targetProfile: "mirrorecma-async-v1";
  readonly stateComputerContractVersion: "mirrors.async-state-computer/v1";
  readonly descriptor: SemanticDescriptor;
  readonly provenance?: { readonly modelSha256: string; readonly sources?: readonly { readonly module: string; readonly sha256: string }[] };
  readonly metadata: GeneratedModelInterface;
  readonly publicManifest: SuitePublicManifest;
  readonly bindPublicPort: (port: SuitePublicPort, config: ApalacheConfig) => SuiteBinding;
  readonly bindLocal: (port: Port, config: ApalacheConfig) => SuiteBinding;
}
export interface CorpusTrace {
  readonly path: string;
  readonly sha256: string;
  /** Existing transport semantics: path visible to the model server. */
  readonly serverPath?: string;
}
export interface ReplayPlan {
  readonly kind: "corpus";
  readonly config: ApalacheConfig;
  /** Local reviewed model source when config.specPath names a server-visible path. */
  readonly modelSource?: string;
  readonly traces: readonly (string | CorpusTrace)[];
  readonly provenance?: {
    readonly interfaceDigest: string;
    readonly modelSha256?: string;
    readonly corpusDigest?: string;
  };
}
export interface SuiteDefinition<Port = NativeSuiteAdapter> {
  readonly id: string;
  readonly adapterId: string;
  readonly model: SuiteModel<Port>;
  readonly replay: ReplayPlan;
  readonly acceptance: AcceptanceRequirements;
}
export class SuiteConfigurationError extends Error {
  readonly code = "suite_configuration_invalid";
}
/** Snapshot only inert data; functions are trusted generated code, retained by identity. */
export function freezeSuiteData<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeSuiteData)) as T;
  if (value !== null && typeof value === "object") {
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) result[key] = freezeSuiteData(item);
    return Object.freeze(result) as T;
  }
  return value;
}
export function defineSuite<Port>(input: {
  readonly id: string; readonly adapterId?: string; readonly model: SuiteModel<Port>;
  readonly replay: ReplayPlan; readonly acceptance?: AcceptanceRequirements;
}): SuiteDefinition<Port> {
  const fail = (message: string): never => { throw new SuiteConfigurationError(message); };
  if (typeof input.id !== "string" || !input.id.trim()) fail("suite id must be nonempty");
  const model = input.model;
  if (model.schema !== "mirrors.suite-model/v1" || model.nativeRepresentation !== "mirrors.node-native/v1" ||
      model.targetProfile !== "mirrorecma-async-v1" || model.stateComputerContractVersion !== "mirrors.async-state-computer/v1") {
    fail("unsupported suite model capability");
  }
  const descriptor = decodeSemanticDescriptor(model.descriptor);
  const digest = semanticDescriptorDigest(descriptor);
  if (digest !== model.semanticDigest || digest !== model.metadata.semanticDigest || digest !== model.publicManifest.interfaceDigest) {
    fail("suite model identity mismatch");
  }
  const contract = decodeContractV1(model.metadata.contract);
  if (contract.model.module !== descriptor.model.module || contract.interfaceVersion !== descriptor.interfaceVersion ||
      JSON.stringify(contract.initializers.map((a) => [a.id, a.wireAction, a.wireAliases])) !==
        JSON.stringify(descriptor.initializers.map((a) => [a.id, a.wireAction, a.wireAliases])) ||
      JSON.stringify(contract.actions.map((a) => [a.id, a.wireAction, a.wireAliases])) !==
        JSON.stringify(descriptor.actions.map((a) => [a.id, a.wireAction, a.wireAliases]))) fail("metadata disagrees with descriptor");
  const publicShape = (actions: SemanticDescriptor["actions"]) => actions.map((a) => ({ id: a.id, inputs: a.inputs.map((i) => ({id: i.id, type: i.type})) }));
  const expectedManifest = {schema: "mirrorgate.port/v1", interfaceDigest: digest,
    initializers: publicShape(descriptor.initializers), actions: publicShape(descriptor.actions),
    observations: descriptor.observations.map((o) => ({ id: o.id, type: o.type }))};
  const canonical = (value: unknown): string => JSON.stringify(value, function(_key, item) {
    if (item && typeof item === "object" && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    return item;
  });
  if (canonical(expectedManifest) !== canonical(model.publicManifest)) fail("public manifest disagrees with descriptor");
  const metadataActions = [...contract.initializers,...contract.actions];
  const resolvedActions = [...descriptor.initializers,...descriptor.actions];
  for (const [index, action] of metadataActions.entries()) {
    const resolved = resolvedActions[index]!;
    if (action.inputs.length !== resolved.inputs.length || action.inputs.some((input,position)=> {
      const expected = resolved.inputs[position]!;
      return input.id !== expected.id || canonical(input.from) !== canonical(expected.from) ||
        (input.expectedType !== undefined && canonical(input.expectedType) !== canonical(expected.type));
    })) fail("metadata input projection disagrees with descriptor");
  }
  if (contract.observations.length !== descriptor.observations.length || contract.observations.some((observation,index)=> {
    const resolved = descriptor.observations[index]!;
    return observation.id !== resolved.id || observation.wireName !== resolved.wireName || observation.provenance !== resolved.provenance ||
      (observation.expectedType !== undefined && canonical(observation.expectedType) !== canonical(resolved.type));
  })) fail("metadata observation projection disagrees with descriptor");
  if (contract.wire.actionVariable !== descriptor.runProfile.actionVariable || contract.wire.parameterVariable !== descriptor.runProfile.configuredParamVar) fail("metadata wire profile disagrees with descriptor");

  const portable = (type: ModelType): void => {
    if (type.kind === "opaqueItf" || (type.kind === "map" && type.key.kind !== "str")) fail("unsupported native representation");
    if (type.kind === "set" || type.kind === "seq") portable(type.element);
    if (type.kind === "tuple") type.elements.forEach(portable);
    if (type.kind === "record") type.fields.forEach((f) => portable(f.type));
    if (type.kind === "variant") type.cases.forEach((c) => portable(c.payload));
    if (type.kind === "map") portable(type.value);
  };
  [...descriptor.initializers, ...descriptor.actions].forEach((a) => a.inputs.forEach((i) => portable(i.type)));
  descriptor.observations.forEach((o) => portable(o.type));
  if (typeof model.bindLocal !== "function" || typeof model.bindPublicPort !== "function") fail("missing generated binding");
  if (model.provenance !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(model.provenance.modelSha256)) fail("invalid bundle source provenance");
    if (model.provenance.sources !== undefined) {
      const sources = model.provenance.sources;
      if (!Array.isArray(sources) || sources.length === 0 || sources.some((source) => !source.module || !/^[a-f0-9]{64}$/.test(source.sha256)) || new Set(sources.map((source)=>source.module)).size !== sources.length) fail("invalid bundle source closure provenance");
      if (sources.find((source)=>source.module === descriptor.model.module)?.sha256 !== model.provenance.modelSha256) fail("bundle root source provenance mismatch");
    }
  }
  const replay = input.replay;
  if (Object.keys(replay).some((key)=>!["kind","config","traces","modelSource","provenance"].includes(key))) fail("unknown replay field");
  if (replay.modelSource !== undefined && (typeof replay.modelSource !== "string" || !replay.modelSource)) fail("invalid local model source");
  if (replay.kind !== "corpus" || !Array.isArray(replay.traces) || replay.traces.length === 0) fail("a nonempty ordered corpus is required");
  for (const trace of replay.traces) {
    if (typeof trace === "string" ? !trace : !trace || typeof trace.path !== "string" || !trace.path || !/^[a-f0-9]{64}$/.test(trace.sha256) || (trace.serverPath !== undefined && !trace.serverPath)) fail("invalid corpus trace reference");
  }
  if (!replay.config || typeof replay.config.specPath !== "string" || !replay.config.specPath || !Number.isSafeInteger(replay.config.lengthBound) || replay.config.lengthBound < 0) fail("invalid replay configuration");
  if (Object.keys(replay.config).some((key)=>!["specPath","initPredicate","nextPredicate","constInit","invariant","lengthBound","paramVars"].includes(key)) ||
      typeof replay.config.invariant !== "string" || !replay.config.invariant ||
      [replay.config.initPredicate,replay.config.nextPredicate,replay.config.constInit].some((value)=>value !== undefined && value !== null && typeof value !== "string") ||
      (replay.config.paramVars !== undefined && typeof replay.config.paramVars !== "string")) fail("invalid replay configuration fields");
  if ((replay.config.paramVars ?? null) !== descriptor.runProfile.configuredParamVar) fail("replay parameter configuration disagrees with model");
  if (replay.provenance !== undefined) {
    if (replay.provenance.interfaceDigest !== digest) fail("corpus interface provenance mismatch");
    for (const value of [replay.provenance.modelSha256, replay.provenance.corpusDigest]) {
      if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) fail("invalid provenance digest");
    }
  }
  const acceptance = validateAcceptanceRequirements(input.acceptance ?? {}, new Set(descriptor.actions.map((a) => a.id)));
  const adapterId = input.adapterId ?? "suite.local";
  if (typeof adapterId !== "string" || !adapterId.trim()) fail("adapter id must be nonempty");
  return freezeSuiteData({ id: input.id, adapterId, model: { ...model, descriptor, metadata: { semanticDigest: digest, contract } }, replay, acceptance });
}
