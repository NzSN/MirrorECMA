import type { ApalacheConfig, State, StateComputer, Value } from "./protocol.js";
import {
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
  type CanonicalItfLiteral,
  type ContractPathSegment,
  type ModelType,
  type ResolvedAction,
  type SemanticDescriptor,
  type SemanticDigest,
} from "./model-interface.js";

export interface NativeModelArray extends ReadonlyArray<NativeModelValue> {}
export interface NativeModelRecord extends Readonly<Record<string, NativeModelValue>> {}
export interface NativeModelMap
  extends ReadonlyArray<readonly [NativeModelValue, NativeModelValue]> {}
export interface NativeModelVariant {
  readonly tag: string;
  readonly value: NativeModelValue;
}

export type NativeModelValue =
  | bigint
  | boolean
  | string
  | null
  | NativeModelArray
  | NativeModelRecord
  | NativeModelMap
  | NativeModelVariant;

export type DynamicActionHandler = (
  inputs: Readonly<Record<string, NativeModelValue>>,
) => void;

export type DynamicObservationHandler = () => NativeModelValue;

/** Local executable behavior only; descriptors never supply handler bodies. */
export interface DynamicHandlerRegistry {
  readonly semanticDigest: SemanticDigest;
  readonly actions: Readonly<Record<string, DynamicActionHandler>>;
  readonly observations: Readonly<Record<string, DynamicObservationHandler>>;
}

export type DynamicBindingErrorCode =
  | "binding_digest_mismatch"
  | "handler_missing"
  | "handler_extra"
  | "observer_missing"
  | "observer_extra"
  | "descriptor_type_unsupported"
  | "configuration_mismatch"
  | "unknown_action"
  | "transition_before_initialization"
  | "input_shape_mismatch"
  | "adapter_failure"
  | "observation_shape_mismatch"
  | "binding_poisoned";

export class DynamicBindingError extends Error {
  constructor(
    readonly code: DynamicBindingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DynamicBindingError";
  }
}

export interface DynamicBinding {
  readonly semanticDigest: SemanticDigest;
  readonly computer: StateComputer;
  assertCompatibleConfig(config: ApalacheConfig): void;
  coverage(): Readonly<Record<string, number>>;
  assertAllActionsCovered(): void;
  dispose(): void | Promise<void>;
}

function bindingError(
  code: DynamicBindingErrorCode,
  message: string,
  cause?: unknown,
): DynamicBindingError {
  return new DynamicBindingError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${path}: expected keys [${wanted.join(", ")}], got [${actual.join(", ")}]`);
  }
}

function valueIdentity(value: Value): string {
  switch (value.tag) {
    case "int": return `int:${value.val}`;
    case "bool": return value.val ? "bool:1" : "bool:0";
    case "str": return `str:${JSON.stringify(value.val)}`;
    case "null": return "null";
    case "set": return `set:[${value.val.map(valueIdentity).sort().join(",")}]`;
    case "seq": return `seq:[${value.val.map(valueIdentity).join(",")}]`;
    case "tuple": return `tuple:[${value.val.map(valueIdentity).join(",")}]`;
    case "record": return `record:{${Object.keys(value.val).sort()
      .map((key) => `${JSON.stringify(key)}:${valueIdentity(value.val[key]!)}`).join(",")}}`;
    case "map": return `map:[${value.val.map(([key, item]) =>
      `${valueIdentity(key)}=>${valueIdentity(item)}`).sort().join(",")}]`;
    case "variant": return `variant:${JSON.stringify(value.variantTag)}=${valueIdentity(value.value)}`;
    case "unserializable": return `unserializable:${JSON.stringify(value.val)}`;
  }
}

function assertUniqueValues(values: readonly Value[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = valueIdentity(value);
    if (seen.has(identity)) throw new Error(`${path}: duplicate set element or map key`);
    seen.add(identity);
  }
}

function literalValue(literal: CanonicalItfLiteral): Value {
  switch (literal.kind) {
    case "int": return { tag: "int", val: BigInt(literal.value) };
    case "bool": return { tag: "bool", val: literal.value };
    case "str": return { tag: "str", val: literal.value };
    case "null": return { tag: "null" };
    case "set": {
      const val = literal.values.map(literalValue);
      assertUniqueValues(val, "mapKey");
      return { tag: "set", val };
    }
    case "seq": return { tag: "seq", val: literal.values.map(literalValue) };
    case "tuple": return { tag: "tuple", val: literal.values.map(literalValue) };
    case "record": {
      const val = Object.create(null) as Record<string, Value>;
      for (const field of literal.fields) {
        if (Object.prototype.hasOwnProperty.call(val, field.name)) {
          throw new Error(`mapKey: duplicate record field ${field.name}`);
        }
        val[field.name] = literalValue(field.value);
      }
      return { tag: "record", val };
    }
    case "map": {
      const val = literal.entries.map((entry): [Value, Value] =>
        [literalValue(entry.key), literalValue(entry.value)]);
      assertUniqueValues(val.map(([key]) => key), "mapKey");
      return { tag: "map", val };
    }
    case "variant":
      return { tag: "variant", variantTag: literal.tag, value: literalValue(literal.payload) };
  }
}

function readPath(root: State, path: readonly ContractPathSegment[], label: string): Value {
  let value: Value = { tag: "record", val: root };
  for (const segment of path) {
    if ("field" in segment) {
      if (value.tag !== "record" || !Object.prototype.hasOwnProperty.call(value.val, segment.field)) {
        throw new Error(`${label}: missing record field ${segment.field}`);
      }
      value = value.val[segment.field]!;
    } else if ("index" in segment) {
      if ((value.tag !== "seq" && value.tag !== "tuple") || segment.index >= value.val.length) {
        throw new Error(`${label}: missing index ${segment.index}`);
      }
      value = value.val[segment.index]!;
    } else if ("variantValue" in segment) {
      if (value.tag !== "variant" || value.variantTag !== segment.variantValue) {
        throw new Error(`${label}: expected variant ${segment.variantValue}`);
      }
      value = value.value;
    } else {
      if (value.tag !== "map") throw new Error(`${label}: mapKey requires a map`);
      assertUniqueValues(value.val.map(([key]) => key), label);
      const expected = valueIdentity(literalValue(segment.mapKey));
      const found: [Value, Value] | undefined = value.val.find(
        ([key]) => valueIdentity(key) === expected,
      );
      if (found === undefined) throw new Error(`${label}: map key is absent`);
      value = found[1];
    }
  }
  return value;
}

function freezeArray<T>(values: T[]): readonly T[] {
  return Object.freeze(values);
}

function rejectDeferredResult(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null || !("then" in value) ||
      typeof (value as { then?: unknown }).then !== "function") return;
  void Promise.resolve(value).catch(() => {});
  throw new Error(`${path}: asynchronous callbacks are unsupported`);
}

function decodeNative(value: Value, shape: ModelType, path: string): NativeModelValue {
  switch (shape.kind) {
    case "int": if (value.tag === "int") return value.val; break;
    case "bool": if (value.tag === "bool") return value.val; break;
    case "str": if (value.tag === "str") return value.val; break;
    case "null": if (value.tag === "null") return null; break;
    case "set":
      if (value.tag === "set") {
        assertUniqueValues(value.val, path);
        return freezeArray(value.val.map((item, index) =>
          decodeNative(item, shape.element, `${path}[${index}]`)));
      }
      break;
    case "seq":
      if (value.tag === "seq") {
        return freezeArray(value.val.map((item, index) =>
          decodeNative(item, shape.element, `${path}[${index}]`)));
      }
      break;
    case "tuple":
      if (value.tag === "tuple" && value.val.length === shape.elements.length) {
        return freezeArray(value.val.map((item, index) =>
          decodeNative(item, shape.elements[index]!, `${path}[${index}]`)));
      }
      break;
    case "record":
      if (value.tag === "record") {
        exactKeys(value.val, shape.fields.map((field) => field.wireName), path);
        const result = Object.create(null) as Record<string, NativeModelValue>;
        for (const field of shape.fields) {
          result[field.wireName] = decodeNative(
            value.val[field.wireName]!,
            field.type,
            `${path}.${field.wireName}`,
          );
        }
        return Object.freeze(result);
      }
      break;
    case "map":
      if (value.tag === "map") {
        assertUniqueValues(value.val.map(([key]) => key), path);
        return freezeArray(value.val.map(([key, item], index) => Object.freeze([
          decodeNative(key, shape.key, `${path}[${index}].key`),
          decodeNative(item, shape.value, `${path}[${index}].value`),
        ]) as readonly [NativeModelValue, NativeModelValue]));
      }
      break;
    case "variant":
      if (value.tag === "variant") {
        const found = shape.cases.find((item) => item.tag === value.variantTag);
        if (found !== undefined) {
          return Object.freeze({
            tag: value.variantTag,
            value: decodeNative(value.value, found.payload, `${path}.value`),
          });
        }
      }
      break;
    case "opaqueItf":
      break;
  }
  throw new Error(`${path}: value does not match ${shape.kind}`);
}

function encodeNative(value: NativeModelValue, shape: ModelType, path: string): Value {
  switch (shape.kind) {
    case "int": if (typeof value === "bigint") return { tag: "int", val: value }; break;
    case "bool": if (typeof value === "boolean") return { tag: "bool", val: value }; break;
    case "str": if (typeof value === "string") return { tag: "str", val: value }; break;
    case "null": if (value === null) return { tag: "null" }; break;
    case "set":
    case "seq":
      if (Array.isArray(value)) {
        const val = value.map((item, index) =>
          encodeNative(item, shape.element, `${path}[${index}]`));
        if (shape.kind === "set") assertUniqueValues(val, path);
        return shape.kind === "set" ? { tag: "set", val } : { tag: "seq", val };
      }
      break;
    case "tuple":
      if (Array.isArray(value) && value.length === shape.elements.length) {
        return {
          tag: "tuple",
          val: value.map((item, index) =>
            encodeNative(item, shape.elements[index]!, `${path}[${index}]`)),
        };
      }
      break;
    case "record": {
      const record = ownRecord(value);
      if (record !== null) {
        exactKeys(record, shape.fields.map((field) => field.wireName), path);
        const val = Object.create(null) as Record<string, Value>;
        for (const field of shape.fields) {
          val[field.wireName] = encodeNative(
            record[field.wireName] as NativeModelValue,
            field.type,
            `${path}.${field.wireName}`,
          );
        }
        return { tag: "record", val };
      }
      break;
    }
    case "map":
      if (Array.isArray(value)) {
        const val: [Value, Value][] = value.map((entry, index) => {
          if (!Array.isArray(entry) || entry.length !== 2) {
            throw new Error(`${path}[${index}]: expected map entry`);
          }
          return [
            encodeNative(entry[0], shape.key, `${path}[${index}].key`),
            encodeNative(entry[1], shape.value, `${path}[${index}].value`),
          ];
        });
        assertUniqueValues(val.map(([key]) => key), path);
        return { tag: "map", val };
      }
      break;
    case "variant": {
      const variant = ownRecord(value);
      if (variant !== null && typeof variant.tag === "string") {
        exactKeys(variant, ["tag", "value"], path);
        const found = shape.cases.find((item) => item.tag === variant.tag);
        if (found !== undefined) {
          return {
            tag: "variant",
            variantTag: variant.tag,
            value: encodeNative(
              variant.value as NativeModelValue,
              found.payload,
              `${path}.value`,
            ),
          };
        }
      }
      break;
    }
    case "opaqueItf":
      break;
  }
  throw new Error(`${path}: implementation value does not match ${shape.kind}`);
}

function assertSupportedType(type: ModelType, path: string): void {
  switch (type.kind) {
    case "int":
    case "bool":
    case "str":
    case "null": return;
    case "set":
    case "seq": return assertSupportedType(type.element, `${path}.element`);
    case "tuple":
      type.elements.forEach((item, index) => assertSupportedType(item, `${path}.elements[${index}]`));
      return;
    case "record":
      type.fields.forEach((field) => assertSupportedType(field.type, `${path}.${field.wireName}`));
      return;
    case "map":
      assertSupportedType(type.key, `${path}.key`);
      assertSupportedType(type.value, `${path}.value`);
      return;
    case "variant":
      type.cases.forEach((item) => assertSupportedType(item.payload, `${path}.${item.tag}`));
      return;
    case "opaqueItf":
      throw bindingError(
        "descriptor_type_unsupported",
        `${path}: opaqueItf is unsupported by mirrorecma-v1 dynamic bindings`,
      );
  }
}

function assertExactRegistry(
  actual: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  missingCode: "handler_missing" | "observer_missing",
  extraCode: "handler_extra" | "observer_extra",
): void {
  const actualKeys = Reflect.ownKeys(actual);
  const missing = expected.filter((key) => {
    const property = Object.getOwnPropertyDescriptor(actual, key);
    return property === undefined || !("value" in property) || typeof property.value !== "function";
  });
  if (missing.length > 0) throw bindingError(missingCode, `missing callable IDs: ${missing.join(", ")}`);
  const extras = actualKeys.filter((key) => typeof key !== "string" || !expected.includes(key));
  if (extras.length > 0) {
    throw bindingError(extraCode, `extra IDs: ${extras.map(String).join(", ")}`);
  }
}

function ownCallback<T extends Function>(value: object, key: string): T {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (property === undefined || !("value" in property) || typeof property.value !== "function") {
    throw new Error(`validated callback ${key} disappeared`);
  }
  return property.value as T;
}

function comparableInitialState(root: State, descriptor: SemanticDescriptor): State {
  const effective = new Set(descriptor.runProfile.effectiveParamVars);
  const filtered = Object.create(null) as State;
  for (const [name, value] of Object.entries(root)) {
    if (!name.startsWith("#") &&
        name !== descriptor.runProfile.actionVariable &&
        !effective.has(name)) {
      filtered[name] = value;
    }
  }
  return filtered;
}

function projectInputs(
  action: ResolvedAction,
  payload: State,
  descriptor: SemanticDescriptor,
): Readonly<Record<string, NativeModelValue>> {
  const root = action.phase === "initialize"
    ? comparableInitialState(payload, descriptor)
    : payload;
  const inputs = Object.create(null) as Record<string, NativeModelValue>;
  for (const input of action.inputs) {
    const label = `${action.id}.${input.id}`;
    inputs[input.id] = decodeNative(readPath(root, input.from.path, label), input.type, label);
  }
  return Object.freeze(inputs);
}

/** Construct one descriptor-driven binding after negotiation authorization. */
export function bindDynamicDescriptor(
  value: SemanticDescriptor,
  registry: DynamicHandlerRegistry,
  dispose: () => void | Promise<void> = () => {},
): DynamicBinding {
  const descriptor = decodeSemanticDescriptor(value);
  const digest = semanticDescriptorDigest(descriptor);
  if (registry.semanticDigest !== digest) {
    throw bindingError("binding_digest_mismatch", "dynamic registry digest does not match descriptor");
  }
  const actions = [...descriptor.initializers, ...descriptor.actions];
  assertExactRegistry(
    registry.actions,
    actions.map((action) => action.id),
    "handler_missing",
    "handler_extra",
  );
  assertExactRegistry(
    registry.observations,
    descriptor.observations.map((observation) => observation.id),
    "observer_missing",
    "observer_extra",
  );
  for (const action of actions) {
    for (const input of action.inputs) assertSupportedType(input.type, `${action.id}.${input.id}`);
  }
  for (const observation of descriptor.observations) {
    assertSupportedType(observation.type, `observation.${observation.id}`);
  }

  const handlerById = Object.freeze(Object.fromEntries(
    actions.map((action) => [
      action.id,
      ownCallback<DynamicActionHandler>(registry.actions, action.id),
    ] as const),
  ));
  const observerById = Object.freeze(Object.fromEntries(
    descriptor.observations.map((observation) =>
      [
        observation.id,
        ownCallback<DynamicObservationHandler>(registry.observations, observation.id),
      ] as const),
  ));
  const actionByWire = new Map<string, ResolvedAction>();
  for (const action of actions) {
    actionByWire.set(action.wireAction, action);
    for (const alias of action.wireAliases) actionByWire.set(alias, action);
  }
  const counts = Object.fromEntries(actions.map((action) => [action.id, 0])) as Record<string, number>;
  let lifecycle: "fresh" | "initialized" | "poisoned" = "fresh";
  let running = false;
  let disposed = false;
  const wasPoisoned = () => lifecycle === "poisoned";

  const computer: StateComputer = (wireAction, payload, _previousState) => {
    if (lifecycle === "poisoned") throw bindingError("binding_poisoned", "binding is poisoned");
    if (running) {
      lifecycle = "poisoned";
      throw bindingError("adapter_failure", "dynamic binding callbacks must not be reentrant");
    }
    running = true;
    let stage: "dispatch" | "input" | "adapter" | "observation" = "dispatch";
    try {
      const action = actionByWire.get(wireAction);
      if (action === undefined) throw bindingError("unknown_action", `unknown action ${wireAction}`);
      if (action.phase === "transition" && lifecycle === "fresh") {
        throw bindingError("transition_before_initialization", "transition before initialization");
      }
      stage = "input";
      const inputs = projectInputs(action, payload, descriptor);
      stage = "adapter";
      const handlerResult: unknown = handlerById[action.id]!(inputs);
      rejectDeferredResult(handlerResult, action.id);
      if (handlerResult !== undefined) {
        throw new Error(`${action.id}: action handlers must return void`);
      }
      if (wasPoisoned()) {
        throw bindingError("adapter_failure", "reentrant dynamic callback poisoned the binding");
      }
      lifecycle = "initialized";
      stage = "observation";
      const state = Object.create(null) as State;
      const observed = descriptor.observations.map((observation) => {
        const value: unknown = observerById[observation.id]!();
        rejectDeferredResult(value, `observation.${observation.id}`);
        return value as NativeModelValue;
      });
      if (wasPoisoned()) {
        throw new Error("reentrant observation callback poisoned the binding");
      }
      descriptor.observations.forEach((observation, index) => {
        state[observation.wireName] = encodeNative(
          observed[index]!,
          observation.type,
          `observation.${observation.id}`,
        );
      });
      counts[action.id] += 1;
      return state;
    } catch (error) {
      lifecycle = "poisoned";
      if (error instanceof DynamicBindingError && stage === "dispatch") throw error;
      const code = stage === "input"
        ? "input_shape_mismatch"
        : stage === "observation"
          ? "observation_shape_mismatch"
          : "adapter_failure";
      throw bindingError(code, `dynamic binding failed for action ${wireAction}`, error);
    } finally {
      running = false;
    }
  };

  return Object.freeze({
    semanticDigest: digest,
    computer,
    assertCompatibleConfig: (config: ApalacheConfig) => {
      const expected = descriptor.runProfile.configuredParamVar ?? "";
      const actual = config.paramVars ?? "";
      if (actual !== expected) {
        throw bindingError(
          "configuration_mismatch",
          `expected paramVars=${expected}, got ${actual}`,
        );
      }
    },
    coverage: () => Object.freeze({ ...counts }),
    assertAllActionsCovered: () => {
      const unseen = Object.keys(counts).filter((id) => counts[id] === 0);
      if (unseen.length > 0) throw new Error(`uncovered actions: ${unseen.join(", ")}`);
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await dispose();
    },
  });
}
