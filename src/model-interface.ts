import {
  decodeMirrorMessage,
  encodeClientMessage,
  type MirrorMessage,
  type Register,
  type RegisterTraces,
} from "./protocol.js";

export const MODEL_INTERFACE_CONTRACT_SCHEMA = "mirrors.model-interface/v1" as const;
export const MODEL_INTERFACE_NEGOTIATION_SCHEMA =
  "mirrors.model-interface-negotiation/v1" as const;
export const MODEL_INTERFACE_DESCRIPTOR_SCHEMA =
  "mirrors.model-interface-descriptor/v1" as const;
export const MAX_MODEL_INTERFACE_MESSAGE_BYTES = 65_535;
export const MAX_MODEL_INTERFACE_JSON_DEPTH = 128;

declare const semanticDigestBrand: unique symbol;

/** A normalized SHA-256 digest: 64 lowercase hex characters, without a prefix. */
export type SemanticDigest = string & { readonly [semanticDigestBrand]: true };

export type NegotiationPolicy = "require" | "prefer";

export type ModelType =
  | { readonly kind: "int" | "bool" | "str" | "null" }
  | { readonly kind: "set" | "seq"; readonly element: ModelType }
  | { readonly kind: "tuple"; readonly elements: readonly ModelType[] }
  | {
      readonly kind: "record";
      readonly fields: readonly {
        readonly wireName: string;
        readonly type: ModelType;
      }[];
    }
  | { readonly kind: "map"; readonly key: ModelType; readonly value: ModelType }
  | {
      readonly kind: "variant";
      readonly cases: readonly {
        readonly tag: string;
        readonly payload: ModelType;
      }[];
    }
  | { readonly kind: "opaqueItf"; readonly description: string };

export type CanonicalItfLiteral =
  | { readonly kind: "int"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "str"; readonly value: string }
  | { readonly kind: "null" }
  | {
      readonly kind: "set" | "seq" | "tuple";
      readonly values: readonly CanonicalItfLiteral[];
    }
  | {
      readonly kind: "record";
      readonly fields: readonly {
        readonly name: string;
        readonly value: CanonicalItfLiteral;
      }[];
    }
  | {
      readonly kind: "map";
      readonly entries: readonly {
        readonly key: CanonicalItfLiteral;
        readonly value: CanonicalItfLiteral;
      }[];
    }
  | {
      readonly kind: "variant";
      readonly tag: string;
      readonly payload: CanonicalItfLiteral;
    };

export type ContractPathSegment =
  | { readonly field: string }
  | { readonly index: number }
  | { readonly mapKey: CanonicalItfLiteral }
  | { readonly variantValue: string };

export interface ContractInput {
  readonly id: string;
  readonly from: {
    readonly root: "initialState" | "stepParameters";
    readonly path: readonly ContractPathSegment[];
  };
  readonly expectedType?: ModelType;
}

export interface ContractAction {
  readonly id: string;
  readonly wireAction: string;
  readonly wireAliases: readonly string[];
  readonly inputs: readonly ContractInput[];
}

export interface ContractObservation {
  readonly id: string;
  readonly wireName: string;
  readonly provenance: "implementation" | "oracle" | "derived";
  readonly expectedType?: ModelType;
}

export interface ContractV1 {
  readonly schema: typeof MODEL_INTERFACE_CONTRACT_SCHEMA;
  readonly interfaceVersion: string;
  readonly model: {
    readonly module: string;
    readonly source: string;
  };
  readonly wire: {
    readonly actionVariable: string;
    readonly parameterVariable: string | null;
  };
  readonly initializers: readonly ContractAction[];
  readonly actions: readonly ContractAction[];
  readonly observations: readonly ContractObservation[];
}

/** Shape embedded into every generated static binding by model_interface_gen. */
export interface GeneratedModelInterface {
  readonly semanticDigest: string;
  readonly contract: ContractV1;
}

export interface ModelInterfaceVerifyRequest {
  readonly schema: typeof MODEL_INTERFACE_NEGOTIATION_SCHEMA;
  readonly request: "verify";
  readonly policy: NegotiationPolicy;
  readonly acceptDescriptorSchemas: readonly [typeof MODEL_INTERFACE_DESCRIPTOR_SCHEMA];
  readonly expectedSemanticDigest: SemanticDigest;
  readonly contract: { readonly inline: ContractV1 };
}

export type ModelInterfaceReply =
  | {
      readonly kind: "reply";
      readonly schema: typeof MODEL_INTERFACE_NEGOTIATION_SCHEMA;
      readonly status: "matched";
      readonly descriptorSchema: typeof MODEL_INTERFACE_DESCRIPTOR_SCHEMA;
      readonly semanticDigest: SemanticDigest;
      readonly provenanceDigest?: SemanticDigest;
    }
  | {
      readonly kind: "reply";
      readonly schema: typeof MODEL_INTERFACE_NEGOTIATION_SCHEMA;
      readonly status: "unsupported" | "unavailable";
    };

export interface ModelInterfaceFailure {
  readonly kind: "failure";
  readonly schema: typeof MODEL_INTERFACE_NEGOTIATION_SCHEMA;
  readonly status: "mismatch" | "unsupported" | "unavailable";
  readonly code: string;
  readonly expectedSemanticDigest?: SemanticDigest;
  readonly actualSemanticDigest?: SemanticDigest;
  readonly provenanceDigest?: SemanticDigest;
}

export interface DecodedModelInterfaceMirrorMessage {
  readonly message: MirrorMessage;
  readonly modelInterface?: ModelInterfaceReply | ModelInterfaceFailure;
}

export class ModelInterfaceProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelInterfaceProtocolError";
  }
}

function fail(path: string, message: string): never {
  throw new ModelInterfaceProtocolError(`${path}: ${message}`);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertShortString(value: string, path: string): string {
  if (byteLength(value) > 256) fail(path, "string exceeds 256 UTF-8 bytes");
  return value;
}

export function semanticDigestFromHex(value: string): SemanticDigest {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    fail("semanticDigest", "expected exactly 64 lowercase hexadecimal characters");
  }
  return value as SemanticDigest;
}

export function parseWireSemanticDigest(value: string): SemanticDigest {
  if (!value.startsWith("sha256:")) {
    fail("digest", "expected the 'sha256:' prefix");
  }
  return semanticDigestFromHex(value.slice(7));
}

export function renderWireSemanticDigest(value: SemanticDigest): `sha256:${string}` {
  return `sha256:${semanticDigestFromHex(value)}`;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as JsonObject;
}

function exactObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): JsonObject {
  const result = object(value, path);
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) fail(path, `unknown field '${key}'`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      fail(path, `missing required field '${key}'`);
    }
  }
  return result;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "expected a nonnegative safe integer");
  }
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function optional<T>(value: unknown, decode: (value: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : decode(value);
}

function frozen<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

interface TypeBudget {
  nodes: number;
}

function decodeModelType(
  value: unknown,
  path: string,
  depth: number,
  budget: TypeBudget,
): ModelType {
  if (depth >= 32) fail(path, "structural type nesting exceeds 32");
  budget.nodes += 1;
  if (budget.nodes > 8_192) fail(path, "structural type graph exceeds 8192 nodes");
  const tagged = object(value, path);
  const kind = string(tagged.kind, `${path}.kind`);
  switch (kind) {
    case "int":
    case "bool":
    case "str":
    case "null":
      exactObject(value, path, ["kind"], ["kind"]);
      return frozen({ kind });
    case "set":
    case "seq": {
      const fields = exactObject(value, path, ["kind", "element"], ["kind", "element"]);
      return frozen({
        kind,
        element: decodeModelType(fields.element, `${path}.element`, depth + 1, budget),
      });
    }
    case "tuple": {
      const fields = exactObject(value, path, ["kind", "elements"], ["kind", "elements"]);
      const elements = array(fields.elements, `${path}.elements`).map((item, index) =>
        decodeModelType(item, `${path}.elements[${index}]`, depth + 1, budget),
      );
      return frozen({ kind, elements: frozen(elements) });
    }
    case "record": {
      const fields = exactObject(value, path, ["kind", "fields"], ["kind", "fields"]);
      const decoded = array(fields.fields, `${path}.fields`).map((item, index) => {
        const itemPath = `${path}.fields[${index}]`;
        const field = exactObject(item, itemPath, ["wireName", "type"], ["wireName", "type"]);
        return frozen({
          wireName: assertShortString(string(field.wireName, `${itemPath}.wireName`), `${itemPath}.wireName`),
          type: decodeModelType(field.type, `${itemPath}.type`, depth + 1, budget),
        });
      });
      return frozen({ kind, fields: frozen(decoded) });
    }
    case "map": {
      const fields = exactObject(value, path, ["kind", "key", "value"], ["kind", "key", "value"]);
      return frozen({
        kind,
        key: decodeModelType(fields.key, `${path}.key`, depth + 1, budget),
        value: decodeModelType(fields.value, `${path}.value`, depth + 1, budget),
      });
    }
    case "variant": {
      const fields = exactObject(value, path, ["kind", "cases"], ["kind", "cases"]);
      const cases = array(fields.cases, `${path}.cases`).map((item, index) => {
        const itemPath = `${path}.cases[${index}]`;
        const variant = exactObject(item, itemPath, ["tag", "payload"], ["tag", "payload"]);
        return frozen({
          tag: assertShortString(string(variant.tag, `${itemPath}.tag`), `${itemPath}.tag`),
          payload: decodeModelType(variant.payload, `${itemPath}.payload`, depth + 1, budget),
        });
      });
      return frozen({ kind, cases: frozen(cases) });
    }
    case "opaqueItf": {
      const fields = exactObject(value, path, ["kind", "description"], ["kind", "description"]);
      return frozen({ kind, description: string(fields.description, `${path}.description`) });
    }
    default:
      return fail(`${path}.kind`, `unknown structural type '${kind}'`);
  }
}

function decodeLiteral(value: unknown, path: string, depth = 0): CanonicalItfLiteral {
  if (depth >= 128) fail(path, "literal nesting exceeds 128");
  const tagged = object(value, path);
  const kind = string(tagged.kind, `${path}.kind`);
  switch (kind) {
    case "int": {
      const fields = exactObject(value, path, ["kind", "value"], ["kind", "value"]);
      const literal = string(fields.value, `${path}.value`);
      if (!/^-?(0|[1-9][0-9]*)$/.test(literal)) fail(`${path}.value`, "expected a canonical decimal integer");
      return frozen({ kind, value: literal });
    }
    case "bool": {
      const fields = exactObject(value, path, ["kind", "value"], ["kind", "value"]);
      if (typeof fields.value !== "boolean") fail(`${path}.value`, "expected a boolean");
      return frozen({ kind, value: fields.value });
    }
    case "str": {
      const fields = exactObject(value, path, ["kind", "value"], ["kind", "value"]);
      return frozen({ kind, value: string(fields.value, `${path}.value`) });
    }
    case "null":
      exactObject(value, path, ["kind"], ["kind"]);
      return frozen({ kind });
    case "set":
    case "seq":
    case "tuple": {
      const fields = exactObject(value, path, ["kind", "values"], ["kind", "values"]);
      const values = array(fields.values, `${path}.values`).map((item, index) =>
        decodeLiteral(item, `${path}.values[${index}]`, depth + 1),
      );
      return frozen({ kind, values: frozen(values) });
    }
    case "record": {
      const fields = exactObject(value, path, ["kind", "fields"], ["kind", "fields"]);
      const decoded = array(fields.fields, `${path}.fields`).map((item, index) => {
        const itemPath = `${path}.fields[${index}]`;
        const entry = exactObject(item, itemPath, ["name", "value"], ["name", "value"]);
        return frozen({
          name: string(entry.name, `${itemPath}.name`),
          value: decodeLiteral(entry.value, `${itemPath}.value`, depth + 1),
        });
      });
      return frozen({ kind, fields: frozen(decoded) });
    }
    case "map": {
      const fields = exactObject(value, path, ["kind", "entries"], ["kind", "entries"]);
      const entries = array(fields.entries, `${path}.entries`).map((item, index) => {
        const itemPath = `${path}.entries[${index}]`;
        const entry = exactObject(item, itemPath, ["key", "value"], ["key", "value"]);
        return frozen({
          key: decodeLiteral(entry.key, `${itemPath}.key`, depth + 1),
          value: decodeLiteral(entry.value, `${itemPath}.value`, depth + 1),
        });
      });
      return frozen({ kind, entries: frozen(entries) });
    }
    case "variant": {
      const fields = exactObject(value, path, ["kind", "tag", "payload"], ["kind", "tag", "payload"]);
      return frozen({
        kind,
        tag: string(fields.tag, `${path}.tag`),
        payload: decodeLiteral(fields.payload, `${path}.payload`, depth + 1),
      });
    }
    default:
      return fail(`${path}.kind`, `unknown canonical literal '${kind}'`);
  }
}

function decodePathSegment(value: unknown, path: string): ContractPathSegment {
  const fields = object(value, path);
  const keys = Object.keys(fields);
  if (keys.length !== 1) fail(path, "path segment must contain exactly one selector");
  switch (keys[0]) {
    case "field":
      return frozen({ field: assertShortString(string(fields.field, `${path}.field`), `${path}.field`) });
    case "index":
      return frozen({ index: nonnegativeInteger(fields.index, `${path}.index`) });
    case "mapKey":
      return frozen({ mapKey: decodeLiteral(fields.mapKey, `${path}.mapKey`) });
    case "variantValue":
      return frozen({ variantValue: assertShortString(string(fields.variantValue, `${path}.variantValue`), `${path}.variantValue`) });
    default:
      return fail(path, `unknown path selector '${keys[0] ?? ""}'`);
  }
}

function decodeContractInput(value: unknown, path: string, budget: TypeBudget): ContractInput {
  const fields = exactObject(value, path, ["id", "from", "expectedType"], ["id", "from"]);
  const from = exactObject(fields.from, `${path}.from`, ["root", "path"], ["root", "path"]);
  const root = string(from.root, `${path}.from.root`);
  if (root !== "initialState" && root !== "stepParameters") {
    fail(`${path}.from.root`, `unknown path root '${root}'`);
  }
  const rawPath = array(from.path, `${path}.from.path`);
  if (rawPath.length > 32) fail(`${path}.from.path`, "path exceeds 32 segments");
  const decodedPath = rawPath.map((item, index) => decodePathSegment(item, `${path}.from.path[${index}]`));
  const expectedType = optional(fields.expectedType, (item) =>
    decodeModelType(item, `${path}.expectedType`, 0, budget),
  );
  return frozen({
    id: assertShortString(string(fields.id, `${path}.id`), `${path}.id`),
    from: frozen({ root, path: frozen(decodedPath) }),
    ...(expectedType === undefined ? {} : { expectedType }),
  });
}

function decodeContractAction(value: unknown, path: string, budget: TypeBudget): ContractAction {
  const fields = exactObject(
    value,
    path,
    ["id", "wireAction", "wireAliases", "inputs"],
    ["id", "wireAction", "wireAliases", "inputs"],
  );
  const rawAliases = array(fields.wireAliases, `${path}.wireAliases`);
  if (rawAliases.length > 16) fail(`${path}.wireAliases`, "array exceeds 16 aliases");
  const wireAliases = rawAliases.map((item, index) =>
    assertShortString(string(item, `${path}.wireAliases[${index}]`), `${path}.wireAliases[${index}]`),
  );
  const rawInputs = array(fields.inputs, `${path}.inputs`);
  if (rawInputs.length > 128) fail(`${path}.inputs`, "array exceeds 128 inputs");
  const inputs = rawInputs.map((item, index) => decodeContractInput(item, `${path}.inputs[${index}]`, budget));
  return frozen({
    id: assertShortString(string(fields.id, `${path}.id`), `${path}.id`),
    wireAction: assertShortString(string(fields.wireAction, `${path}.wireAction`), `${path}.wireAction`),
    wireAliases: frozen(wireAliases),
    inputs: frozen(inputs),
  });
}

/** Validate, clone, and deeply freeze a version-1 companion contract. */
export function decodeContractV1(value: unknown): ContractV1 {
  const path = "contract";
  const fields = exactObject(
    value,
    path,
    ["schema", "interfaceVersion", "model", "wire", "initializers", "actions", "observations"],
    ["schema", "interfaceVersion", "model", "wire", "initializers", "actions", "observations"],
  );
  if (fields.schema !== MODEL_INTERFACE_CONTRACT_SCHEMA) {
    fail(`${path}.schema`, `expected '${MODEL_INTERFACE_CONTRACT_SCHEMA}'`);
  }
  const model = exactObject(fields.model, `${path}.model`, ["module", "source"], ["module", "source"]);
  const wire = exactObject(
    fields.wire,
    `${path}.wire`,
    ["actionVariable", "parameterVariable"],
    ["actionVariable", "parameterVariable"],
  );
  const parameterVariable: string | null = wire.parameterVariable === null
    ? null
    : string(wire.parameterVariable, `${path}.wire.parameterVariable`);
  const budget: TypeBudget = { nodes: 0 };
  const rawInitializers = array(fields.initializers, `${path}.initializers`);
  if (rawInitializers.length > 32) fail(`${path}.initializers`, "array exceeds 32 initializers");
  const initializers = rawInitializers.map((item, index) =>
    decodeContractAction(item, `${path}.initializers[${index}]`, budget),
  );
  const rawActions = array(fields.actions, `${path}.actions`);
  if (rawActions.length > 256) fail(`${path}.actions`, "array exceeds 256 actions");
  const actions = rawActions.map((item, index) => decodeContractAction(item, `${path}.actions[${index}]`, budget));
  const rawObservations = array(fields.observations, `${path}.observations`);
  if (rawObservations.length > 1_024) fail(`${path}.observations`, "array exceeds 1024 observations");
  const observations = rawObservations.map((item, index): ContractObservation => {
    const itemPath = `${path}.observations[${index}]`;
    const observation = exactObject(
      item,
      itemPath,
      ["id", "wireName", "provenance", "expectedType"],
      ["id", "wireName", "provenance"],
    );
    const provenance = string(observation.provenance, `${itemPath}.provenance`);
    if (provenance !== "implementation" && provenance !== "oracle" && provenance !== "derived") {
      fail(`${itemPath}.provenance`, `unknown observation provenance '${provenance}'`);
    }
    const expectedType = optional(observation.expectedType, (value) =>
      decodeModelType(value, `${itemPath}.expectedType`, 0, budget),
    );
    return frozen({
      id: assertShortString(string(observation.id, `${itemPath}.id`), `${itemPath}.id`),
      wireName: assertShortString(string(observation.wireName, `${itemPath}.wireName`), `${itemPath}.wireName`),
      provenance,
      ...(expectedType === undefined ? {} : { expectedType }),
    });
  });
  return frozen({
    schema: MODEL_INTERFACE_CONTRACT_SCHEMA,
    interfaceVersion: assertShortString(string(fields.interfaceVersion, `${path}.interfaceVersion`), `${path}.interfaceVersion`),
    model: frozen({
      module: assertShortString(string(model.module, `${path}.model.module`), `${path}.model.module`),
      source: assertShortString(string(model.source, `${path}.model.source`), `${path}.model.source`),
    }),
    wire: frozen({
      actionVariable: assertShortString(string(wire.actionVariable, `${path}.wire.actionVariable`), `${path}.wire.actionVariable`),
      parameterVariable,
    }),
    initializers: frozen(initializers),
    actions: frozen(actions),
    observations: frozen(observations),
  });
}

/** Build the only request mode supported by compiled D3 adapters. */
export function createVerifyRequest(
  metadata: GeneratedModelInterface,
  policy: NegotiationPolicy = "require",
): ModelInterfaceVerifyRequest {
  if (policy !== "require" && policy !== "prefer") fail("modelInterface.policy", "expected 'require' or 'prefer'");
  const digest = semanticDigestFromHex(metadata.semanticDigest);
  const contract = decodeContractV1(metadata.contract);
  return frozen({
    schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
    request: "verify",
    policy,
    acceptDescriptorSchemas: frozen([MODEL_INTERFACE_DESCRIPTOR_SCHEMA]) as readonly [typeof MODEL_INTERFACE_DESCRIPTOR_SCHEMA],
    expectedSemanticDigest: digest,
    contract: frozen({ inline: contract }),
  });
}

function decodeVerifyRequestValue(value: unknown): ModelInterfaceVerifyRequest {
  const path = "modelInterface";
  const fields = exactObject(
    value,
    path,
    ["schema", "request", "policy", "acceptDescriptorSchemas", "expectedSemanticDigest", "contract"],
    ["schema", "request", "policy", "acceptDescriptorSchemas", "expectedSemanticDigest", "contract"],
  );
  if (fields.schema !== MODEL_INTERFACE_NEGOTIATION_SCHEMA) fail(`${path}.schema`, `expected '${MODEL_INTERFACE_NEGOTIATION_SCHEMA}'`);
  if (fields.request !== "verify") fail(`${path}.request`, "D3 supports only 'verify'");
  const policy = string(fields.policy, `${path}.policy`);
  if (policy !== "require" && policy !== "prefer") fail(`${path}.policy`, "expected 'require' or 'prefer'");
  const schemas = array(fields.acceptDescriptorSchemas, `${path}.acceptDescriptorSchemas`);
  if (schemas.length !== 1 || schemas[0] !== MODEL_INTERFACE_DESCRIPTOR_SCHEMA) {
    fail(`${path}.acceptDescriptorSchemas`, `D3 requires only '${MODEL_INTERFACE_DESCRIPTOR_SCHEMA}'`);
  }
  const contractReference = exactObject(fields.contract, `${path}.contract`, ["inline"], ["inline"]);
  return frozen({
    schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
    request: "verify",
    policy,
    acceptDescriptorSchemas: frozen([MODEL_INTERFACE_DESCRIPTOR_SCHEMA]) as readonly [typeof MODEL_INTERFACE_DESCRIPTOR_SCHEMA],
    expectedSemanticDigest: parseWireSemanticDigest(string(fields.expectedSemanticDigest, `${path}.expectedSemanticDigest`)),
    contract: frozen({ inline: decodeContractV1(contractReference.inline) }),
  });
}

/** Decode a standalone D3 request from a parsed value or strict JSON text. */
export function decodeModelInterfaceRequest(value: unknown): ModelInterfaceVerifyRequest {
  return decodeVerifyRequestValue(value);
}

export function parseModelInterfaceRequest(text: string): ModelInterfaceVerifyRequest {
  return decodeVerifyRequestValue(parseStrictJson(text));
}

function wireRequest(request: ModelInterfaceVerifyRequest): JsonObject {
  const normalized = decodeVerifyRequestValue({
    ...request,
    expectedSemanticDigest: renderWireSemanticDigest(request.expectedSemanticDigest),
  });
  return {
    schema: normalized.schema,
    request: normalized.request,
    policy: normalized.policy,
    acceptDescriptorSchemas: normalized.acceptDescriptorSchemas,
    expectedSemanticDigest: renderWireSemanticDigest(normalized.expectedSemanticDigest),
    contract: normalized.contract,
  };
}

/** Add negotiation to a stepping registration without changing the base object. */
export function encodeModelInterfaceRegistration(
  base: Register | RegisterTraces,
  request: ModelInterfaceVerifyRequest,
): string {
  if (base.proto_step !== "register" && base.proto_step !== "register_traces") {
    fail("registration.proto_step", "negotiation is supported only on stepping registrations");
  }
  if (Object.prototype.hasOwnProperty.call(base, "modelInterface")) {
    fail("registration", "field 'modelInterface' already present");
  }
  const extended = { ...base, modelInterface: wireRequest(request) };
  return encodeClientMessage(extended as typeof base);
}

function digestField(fields: JsonObject, name: string, path: string): SemanticDigest | undefined {
  return optional(fields[name], (value) => parseWireSemanticDigest(string(value, `${path}.${name}`)));
}

function decodeReply(value: unknown): ModelInterfaceReply {
  const path = "modelInterface";
  const fields = exactObject(
    value,
    path,
    ["schema", "status", "descriptorSchema", "semanticDigest", "provenanceDigest", "descriptorBytes", "descriptor"],
    ["schema", "status"],
  );
  if (fields.schema !== MODEL_INTERFACE_NEGOTIATION_SCHEMA) fail(`${path}.schema`, `expected '${MODEL_INTERFACE_NEGOTIATION_SCHEMA}'`);
  const status = string(fields.status, `${path}.status`);
  if (status === "matched") {
    if (fields.descriptorSchema !== MODEL_INTERFACE_DESCRIPTOR_SCHEMA) {
      fail(`${path}.descriptorSchema`, `expected '${MODEL_INTERFACE_DESCRIPTOR_SCHEMA}'`);
    }
    if (fields.descriptor !== undefined && fields.descriptor !== null) fail(`${path}.descriptor`, "forbidden for matched");
    if (fields.descriptorBytes !== undefined && fields.descriptorBytes !== null) fail(`${path}.descriptorBytes`, "forbidden for matched");
    const semanticDigest = digestField(fields, "semanticDigest", path);
    if (semanticDigest === undefined) fail(`${path}.semanticDigest`, "required for matched");
    const provenanceDigest = digestField(fields, "provenanceDigest", path);
    return frozen({
      kind: "reply",
      schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
      status,
      descriptorSchema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
      semanticDigest,
      ...(provenanceDigest === undefined ? {} : { provenanceDigest }),
    });
  }
  if (status === "unsupported" || status === "unavailable") {
    for (const name of ["descriptorSchema", "semanticDigest", "provenanceDigest", "descriptorBytes", "descriptor"] as const) {
      if (fields[name] !== undefined && fields[name] !== null) fail(path, `field '${name}' is forbidden for ${status}`);
    }
    return frozen({ kind: "reply", schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA, status });
  }
  return fail(`${path}.status`, `status '${status}' is not valid for a D3 verify reply`);
}

function decodeFailure(value: unknown): ModelInterfaceFailure {
  const path = "modelInterface";
  const fields = exactObject(
    value,
    path,
    ["schema", "status", "code", "expectedSemanticDigest", "actualSemanticDigest", "provenanceDigest", "descriptorBytes"],
    ["schema", "status", "code"],
  );
  if (fields.schema !== MODEL_INTERFACE_NEGOTIATION_SCHEMA) fail(`${path}.schema`, `expected '${MODEL_INTERFACE_NEGOTIATION_SCHEMA}'`);
  const status = string(fields.status, `${path}.status`);
  if (status !== "mismatch" && status !== "unsupported" && status !== "unavailable") {
    fail(`${path}.status`, `status '${status}' is not valid for a D3 verify failure`);
  }
  const code = string(fields.code, `${path}.code`);
  if (code.length === 0) fail(`${path}.code`, "must not be empty");
  if (fields.descriptorBytes !== undefined && fields.descriptorBytes !== null) {
    nonnegativeInteger(fields.descriptorBytes, `${path}.descriptorBytes`);
    fail(`${path}.descriptorBytes`, "not valid for a D3 verify failure");
  }
  const expectedSemanticDigest = digestField(fields, "expectedSemanticDigest", path);
  const actualSemanticDigest = digestField(fields, "actualSemanticDigest", path);
  const provenanceDigest = digestField(fields, "provenanceDigest", path);
  if (status === "mismatch" && expectedSemanticDigest === undefined) {
    fail(`${path}.expectedSemanticDigest`, "required for mismatch");
  }
  return frozen({
    kind: "failure",
    schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
    status,
    code,
    ...(expectedSemanticDigest === undefined ? {} : { expectedSemanticDigest }),
    ...(actualSemanticDigest === undefined ? {} : { actualSemanticDigest }),
    ...(provenanceDigest === undefined ? {} : { provenanceDigest }),
  });
}

/**
 * Strictly validate the raw first mirror reply, then use the established
 * protocol decoder for the ordinary message fields.
 */
export function decodeModelInterfaceMirrorMessage(text: string): DecodedModelInterfaceMirrorMessage {
  const raw = object(parseStrictJson(text), "mirror message");
  const step = string(raw.proto_step, "mirror message.proto_step");
  const extension = raw.modelInterface;
  let modelInterface: ModelInterfaceReply | ModelInterfaceFailure | undefined;
  if (extension !== undefined && extension !== null) {
    if (step === "spec_validated") modelInterface = decodeReply(extension);
    else if (step === "register_error") modelInterface = decodeFailure(extension);
    else fail("mirror message.modelInterface", "allowed only on spec_validated or register_error");
  }
  const message = decodeMirrorMessage(text);
  if (modelInterface?.kind === "reply" &&
      (message.proto_step !== "spec_validated" || message.result !== "valid")) {
    fail("mirror message.result", "a negotiation reply requires a valid specification result");
  }
  return frozen({ message, ...(modelInterface === undefined ? {} : { modelInterface }) });
}

/** Alias for callers that use registration-oriented naming. */
export const decodeRegistrationReply = decodeModelInterfaceMirrorMessage;

class StrictJsonParser {
  private offset = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.value(0);
    this.whitespace();
    if (this.offset !== this.text.length) this.syntax("trailing characters after JSON value");
    return value;
  }

  private syntax(message: string): never {
    fail(`strict JSON at offset ${this.offset}`, message);
  }

  private whitespace(): void {
    while (this.offset < this.text.length && /[\t\n\r ]/.test(this.text[this.offset]!)) this.offset += 1;
  }

  private value(depth: number): unknown {
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
    if (depth >= MAX_MODEL_INTERFACE_JSON_DEPTH) this.syntax(`JSON nesting exceeds ${MAX_MODEL_INTERFACE_JSON_DEPTH}`);
    return depth + 1;
  }

  private object(depth: number): JsonObject {
    const childDepth = this.containerDepth(depth);
    this.offset += 1;
    this.whitespace();
    const result: JsonObject = Object.create(null) as JsonObject;
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
    if (!Number.isFinite(value)) this.syntax("number is outside the finite range");
    return value;
  }
}

/** Strict JSON parsing with duplicate-key, decoded-byte, and depth checks. */
export function parseStrictJson(text: string): unknown {
  const bytes = byteLength(text);
  if (bytes > MAX_MODEL_INTERFACE_MESSAGE_BYTES) {
    fail("strict JSON", `message is ${bytes} UTF-8 bytes; maximum is ${MAX_MODEL_INTERFACE_MESSAGE_BYTES}`);
  }
  return new StrictJsonParser(text).parse();
}
