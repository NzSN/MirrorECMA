import type { Value } from "./protocol.js";

/** Opaque values remain bounded even though their descriptor has no inner shape. */
export const OPAQUE_ITF_MAX_DEPTH = 64;
export const OPAQUE_ITF_MAX_NODES = 10_000;

type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export type ReadonlyItfValue = DeepReadonly<Value>;

function dataRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected a plain ITF object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path}: expected a plain ITF object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !("value" in property) || !property.enumerable) {
      throw new Error(`${path}: only enumerable string data properties are allowed`);
    }
  }
  return value as Record<string, unknown>;
}

function keys(record: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(record);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new Error(`${path}: unexpected ITF value fields`);
  }
}

function denseArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) {
    throw new Error(`${path}: expected a dense plain array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (property === undefined || !("value" in property) || !property.enumerable) {
      throw new Error(`${path}: expected array data elements`);
    }
  }
  return value;
}

type CanonicalValue = string | boolean | readonly CanonicalValue[];

function sorted(values: CanonicalValue[]): CanonicalValue[] {
  return values.map((value) => ({ value, key: JSON.stringify(value) }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    .map(({ value }) => value);
}

function canonical(value: Value): CanonicalValue {
  switch (value.tag) {
    case "null": return ["null"];
    case "int": return ["int", String(value.val)];
    case "bool":
    case "str":
    case "unserializable": return [value.tag, value.val];
    case "set": return ["set", sorted(value.val.map(canonical))];
    case "seq":
    case "tuple": return [value.tag, value.val.map(canonical)];
    case "record": return ["record", Object.keys(value.val).sort()
      .map((key) => [key, canonical(value.val[key]!)])];
    case "map": return ["map", sorted(value.val
      .map(([key, item]) => [canonical(key), canonical(item)]))];
    case "variant": return ["variant", value.variantTag, canonical(value.value)];
  }
}

/** Canonical equality key for an already validated protocol value. */
function identity(value: Value): string { return JSON.stringify(canonical(value)); }

function unique(values: readonly Value[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = identity(value);
    if (seen.has(key)) throw new Error(`${path}: duplicate set element or map key`);
    seen.add(key);
  }
}

/** Internal checked snapshot shared by typed and opaque dynamic projections. */
export function snapshotItfValue(input: unknown): Value {
  let nodes = 0;
  const visiting = new WeakSet<object>();
  function visit(value: unknown, depth: number, path: string): Value {
    if (depth > OPAQUE_ITF_MAX_DEPTH || ++nodes > OPAQUE_ITF_MAX_NODES) {
      throw new Error(`${path}: ITF value exceeds structural limits`);
    }
    const record = dataRecord(value, path);
    if (visiting.has(record)) throw new Error(`${path}: cyclic ITF value`);
    visiting.add(record);
    try {
      const tag = record.tag;
      keys(record, tag === "null" ? ["tag"] : tag === "variant"
        ? ["tag", "variantTag", "value"] : ["tag", "val"], path);
      let result: Value;
      switch (tag) {
        case "null": result = { tag }; break;
        case "int":
          if (typeof record.val !== "bigint") throw new Error(`${path}: expected bigint`);
          result = { tag, val: record.val }; break;
        case "bool":
          if (typeof record.val !== "boolean") throw new Error(`${path}: expected boolean`);
          result = { tag, val: record.val }; break;
        case "str":
        case "unserializable":
          if (typeof record.val !== "string") throw new Error(`${path}: expected string`);
          result = { tag, val: record.val }; break;
        case "set":
        case "seq":
        case "tuple": {
          const val = denseArray(record.val, `${path}.val`).map((item, index) =>
            visit(item, depth + 1, `${path}[${index}]`));
          if (tag === "set") unique(val, path);
          Object.freeze(val);
          result = { tag, val };
          break;
        }
        case "record": {
          const source = dataRecord(record.val, `${path}.val`);
          const val = Object.create(null) as Record<string, Value>;
          for (const key of Object.keys(source)) val[key] = visit(source[key], depth + 1, `${path}.${key}`);
          Object.freeze(val);
          result = { tag, val };
          break;
        }
        case "map": {
          const val = denseArray(record.val, `${path}.val`).map((item, index): [Value, Value] => {
            const entry = denseArray(item, `${path}[${index}]`);
            if (entry.length !== 2) throw new Error(`${path}[${index}]: expected map entry`);
            const pair: [Value, Value] = [
              visit(entry[0], depth + 1, `${path}[${index}].key`),
              visit(entry[1], depth + 1, `${path}[${index}].value`),
            ];
            Object.freeze(pair);
            return pair;
          });
          unique(val.map(([key]) => key), path);
          Object.freeze(val);
          result = { tag, val };
          break;
        }
        case "variant":
          if (typeof record.variantTag !== "string") throw new Error(`${path}: expected variant tag`);
          result = { tag, variantTag: record.variantTag, value: visit(record.value, depth + 1, `${path}.value`) };
          break;
        default: throw new Error(`${path}: unknown ITF value tag`);
      }
      return Object.freeze(result);
    } finally {
      visiting.delete(record);
    }
  }
  return visit(input, 0, "value");
}

/** Validate before comparing so malformed/deep keys cannot escape structural limits. */
export function itfValueIdentity(value: Value): string {
  return identity(snapshotItfValue(value));
}

/**
 * Branded inert protocol data, distinct from native records and variants.
 * Construction copies and recursively freezes the complete validated value.
 */
export class OpaqueItfValue {
  readonly #value: Value;

  constructor(value: Value) {
    this.#value = snapshotItfValue(value);
    Object.freeze(this);
  }

  get value(): ReadonlyItfValue { return this.#value; }

  static is(value: unknown): value is OpaqueItfValue {
    return typeof value === "object" && value !== null && #value in value;
  }

  /** A fresh snapshot prevents aliases to user-owned observations. */
  static encode(value: unknown): Value {
    if (!OpaqueItfValue.is(value)) throw new Error("opaqueItf requires an OpaqueItfValue wrapper");
    return snapshotItfValue(value.#value);
  }
}

export function opaqueItfValue(value: Value): OpaqueItfValue {
  return new OpaqueItfValue(value);
}
