import {
  DynamicBindingError,
  bindDynamicDescriptor,
  type DynamicHandlerRegistry,
  type NativeModelValue,
} from "../src/dynamic-binding.js";
import {
  MODEL_INTERFACE_COMPARISON_POLICY_VERSION,
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  MODEL_INTERFACE_RESOLVER_SEMANTICS_VERSION,
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
  semanticDigestFromHex,
  type ModelType,
  type SemanticDescriptor,
} from "../src/model-interface.js";
import type { State, Value } from "../src/protocol.js";
import {
  OpaqueItfValue,
  opaqueItfValue,
  OPAQUE_ITF_MAX_DEPTH,
  OPAQUE_ITF_MAX_NODES,
} from "../src/opaque-itf.js";

const int = { kind: "int" } as const;
const bool = { kind: "bool" } as const;
const str = { kind: "str" } as const;
const nil = { kind: "null" } as const;
const opaque = { kind: "opaqueItf", description: "application-owned ITF data" } as const;
const setInt = { kind: "set", element: int } as const;
const seqStr = { kind: "seq", element: str } as const;
const tuple = { kind: "tuple", elements: [int, bool] } as const;
const record = {
  kind: "record",
  fields: [{ wireName: "count", type: int }, { wireName: "ok", type: bool }],
} as const;
const map = { kind: "map", key: str, value: int } as const;
const variant = {
  kind: "variant",
  cases: [{ tag: "Some", payload: int }, { tag: "None", payload: nil }],
} as const;

const shapes: ReadonlyArray<readonly [string, ModelType]> = [
  ["IntValue", int],
  ["BoolValue", bool],
  ["StringValue", str],
  ["NullValue", nil],
  ["SetValue", setInt],
  ["SeqValue", seqStr],
  ["TupleValue", tuple],
  ["RecordValue", record],
  ["MapValue", map],
  ["VariantValue", variant],
  ["OpaqueValue", opaque],
];

function richDescriptor(): SemanticDescriptor {
  return decodeSemanticDescriptor({
    schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
    interfaceVersion: "1.0.0",
    model: { module: "DynamicFixture" },
    resolverSemanticsVersion: MODEL_INTERFACE_RESOLVER_SEMANTICS_VERSION,
    comparisonPolicyVersion: MODEL_INTERFACE_COMPARISON_POLICY_VERSION,
    runProfile: {
      actionVariable: "action_taken",
      configuredParamVar: null,
      itfParamVars: [],
      effectiveParamVars: [],
    },
    initializers: [{
      id: "Initialize",
      phase: "initialize",
      wireAction: "init",
      wireAliases: [],
      inputs: [],
    }],
    actions: [{
      id: "Exercise",
      phase: "transition",
      wireAction: "exercise",
      wireAliases: ["go"],
      inputs: shapes.map(([id, type]) => ({
        id,
        from: { root: "stepParameters", path: [{ field: id }] },
        type,
      })),
    }],
    observations: shapes.map(([id, type]) => ({
      id,
      wireName: id,
      type,
      provenance: "implementation",
    })),
  });
}

function nativeValues(): Record<string, NativeModelValue> {
  return {
    IntValue: 7n,
    BoolValue: true,
    StringValue: "hello",
    NullValue: null,
    SetValue: [1n, 2n],
    SeqValue: ["a", "b"],
    TupleValue: [9n, false],
    RecordValue: { count: 3n, ok: true },
    MapValue: [["a", 1n], ["b", 2n]],
    VariantValue: { tag: "Some", value: 11n },
    OpaqueValue: opaqueItfValue({ tag: "unserializable", val: "model-defined" }),
  };
}

function modelValues(): State {
  return {
    IntValue: { tag: "int", val: 7n },
    BoolValue: { tag: "bool", val: true },
    StringValue: { tag: "str", val: "hello" },
    NullValue: { tag: "null" },
    SetValue: { tag: "set", val: [{ tag: "int", val: 1n }, { tag: "int", val: 2n }] },
    SeqValue: { tag: "seq", val: [{ tag: "str", val: "a" }, { tag: "str", val: "b" }] },
    TupleValue: { tag: "tuple", val: [{ tag: "int", val: 9n }, { tag: "bool", val: false }] },
    RecordValue: {
      tag: "record",
      val: { count: { tag: "int", val: 3n }, ok: { tag: "bool", val: true } },
    },
    MapValue: {
      tag: "map",
      val: [
        [{ tag: "str", val: "a" }, { tag: "int", val: 1n }],
        [{ tag: "str", val: "b" }, { tag: "int", val: 2n }],
      ],
    },
    VariantValue: {
      tag: "variant",
      variantTag: "Some",
      value: { tag: "int", val: 11n },
    },
    OpaqueValue: { tag: "unserializable", val: "model-defined" },
  };
}

function registry(
  descriptor: SemanticDescriptor,
  overrides: {
    actions?: Record<string, (inputs: Readonly<Record<string, NativeModelValue>>) => void>;
    observations?: Record<string, () => NativeModelValue>;
  } = {},
): DynamicHandlerRegistry {
  const values = nativeValues();
  return {
    semanticDigest: semanticDescriptorDigest(descriptor),
    actions: overrides.actions ?? { Initialize: () => {}, Exercise: () => {} },
    observations: overrides.observations ?? Object.fromEntries(
      shapes.map(([id]) => [id, () => values[id]!] as const),
    ),
  };
}

describe("dynamic descriptor binding", () => {
  it("converts every supported native type and exposes only frozen projected inputs", () => {
    const descriptor = richDescriptor();
    const seen: Array<Readonly<Record<string, NativeModelValue>>> = [];
    const binding = bindDynamicDescriptor(descriptor, registry(descriptor, {
      actions: {
        Initialize: (inputs) => { expect(Object.keys(inputs)).toEqual([]); },
        Exercise: (inputs) => { seen.push(inputs); },
      },
    }));

    binding.computer("init", {}, { secret: { tag: "str", val: "not exposed" } });
    const state = binding.computer("go", modelValues(), { secret: { tag: "str", val: "not exposed" } });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(nativeValues());
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]!.RecordValue)).toBe(true);
    expect(Object.isFrozen(seen[0]!.MapValue)).toBe(true);
    expect(state).toEqual(modelValues());
    expect(binding.coverage()).toEqual({ Initialize: 1, Exercise: 1 });
    expect(() => binding.assertAllActionsCovered()).not.toThrow();
  });

  it("decodes every input before invoking the action handler", () => {
    const descriptor = richDescriptor();
    let calls = 0;
    const binding = bindDynamicDescriptor(descriptor, registry(descriptor, {
      actions: { Initialize: () => {}, Exercise: () => { calls += 1; } },
    }));
    binding.computer("init", {}, {});
    const payload = modelValues();
    payload.VariantValue = { tag: "variant", variantTag: "Wrong", value: { tag: "int", val: 0n } };

    expect(() => binding.computer("exercise", payload, {})).toThrow(
      expect.objectContaining({ code: "input_shape_mismatch" }),
    );
    expect(calls).toBe(0);
    expect(() => binding.computer("exercise", modelValues(), {})).toThrow(
      expect.objectContaining({ code: "binding_poisoned" }),
    );
  });

  it("projects field, index, variantValue, and mapKey path segments", () => {
    const value: any = structuredClone(richDescriptor());
    value.actions[0].inputs = [
      { id: "Field", from: { root: "stepParameters", path: [{ field: "record" }, { field: "x" }] }, type: int },
      { id: "Index", from: { root: "stepParameters", path: [{ field: "tuple" }, { index: 1 }] }, type: str },
      { id: "Variant", from: { root: "stepParameters", path: [{ field: "variant" }, { variantValue: "Some" }] }, type: int },
      { id: "MapKey", from: { root: "stepParameters", path: [{ field: "map" }, { mapKey: { kind: "str", value: "key" } }] }, type: bool },
    ];
    value.observations = [];
    const descriptor = decodeSemanticDescriptor(value);
    let projected: Readonly<Record<string, NativeModelValue>> | undefined;
    const binding = bindDynamicDescriptor(descriptor, registry(descriptor, {
      actions: { Initialize: () => {}, Exercise: (inputs) => { projected = inputs; } },
      observations: {},
    }));
    binding.computer("init", {}, {});
    binding.computer("exercise", {
      record: { tag: "record", val: { x: { tag: "int", val: 4n } } },
      tuple: { tag: "tuple", val: [{ tag: "str", val: "zero" }, { tag: "str", val: "one" }] },
      variant: { tag: "variant", variantTag: "Some", value: { tag: "int", val: 5n } },
      map: { tag: "map", val: [[{ tag: "str", val: "key" }, { tag: "bool", val: true }]] },
    }, {});
    expect(projected).toEqual({ Field: 4n, Index: "one", Variant: 5n, MapKey: true });
  });

  it("filters initializer meta/action/effective-param fields before projection", () => {
    const value: any = structuredClone(richDescriptor());
    value.runProfile.configuredParamVar = "parameters";
    value.runProfile.effectiveParamVars = ["parameters"];
    value.initializers[0].inputs = [{
      id: "Visible",
      from: { root: "initialState", path: [{ field: "visible" }] },
      type: int,
    }];
    value.actions = [];
    value.observations = [];
    const descriptor = decodeSemanticDescriptor(value);
    let inputs: Readonly<Record<string, NativeModelValue>> | undefined;
    const binding = bindDynamicDescriptor(descriptor, registry(descriptor, {
      actions: { Initialize: (value) => { inputs = value; } },
      observations: {},
    }));
    binding.assertCompatibleConfig({ specPath: "x", invariant: "I", lengthBound: 1, paramVars: "parameters" });
    binding.computer("init", {
      visible: { tag: "int", val: 3n },
      action_taken: { tag: "str", val: "init" },
      parameters: { tag: "record", val: {} },
      "#meta": { tag: "str", val: "hidden" },
    }, {});
    expect(inputs).toEqual({ Visible: 3n });
  });

  it("rejects registry mismatch before any callback", () => {
    const descriptor = richDescriptor();
    let calls = 0;
    const callbacks = {
      actions: { Initialize: () => { calls += 1; }, Exercise: () => { calls += 1; } },
      observations: Object.fromEntries(shapes.map(([id]) => [id, () => { calls += 1; return null; }])),
    };
    const badCases: Array<[Partial<DynamicHandlerRegistry>, string]> = [
      [{ semanticDigest: semanticDigestFromHex("0".repeat(64)) }, "binding_digest_mismatch"],
      [{ actions: { Initialize: callbacks.actions.Initialize } }, "handler_missing"],
      [{ actions: { ...callbacks.actions, Extra: () => {} } }, "handler_extra"],
      [{ observations: {} }, "observer_missing"],
      [{ observations: { ...callbacks.observations, Extra: () => null } }, "observer_extra"],
    ];
    for (const [override, code] of badCases) {
      expect(() => bindDynamicDescriptor(descriptor, {
        semanticDigest: semanticDescriptorDigest(descriptor),
        ...callbacks,
        ...override,
      })).toThrow(expect.objectContaining({ code }));
    }

    expect(calls).toBe(0);
  });

  it("enforces lifecycle, alias coverage, poisoning, and idempotent disposal", async () => {
    const descriptor = richDescriptor();
    const events: string[] = [];
    let binding!: ReturnType<typeof bindDynamicDescriptor>;
    binding = bindDynamicDescriptor(descriptor, registry(descriptor, {
      actions: {
        Initialize: () => { events.push("init"); },
        Exercise: () => { events.push("exercise"); },
      },
      observations: Object.fromEntries(shapes.map(([id]) => [id, () => nativeValues()[id]!])),
    }), async () => { events.push("dispose"); });

    expect(() => binding.computer("exercise", modelValues(), {})).toThrow(
      expect.objectContaining({ code: "transition_before_initialization" }),
    );
    expect(events).toEqual([]);
    expect(() => binding.computer("init", {}, {})).toThrow(
      expect.objectContaining({ code: "binding_poisoned" }),
    );
    await binding.dispose();
    await binding.dispose();
    expect(events).toEqual(["dispose"]);

    const alias = bindDynamicDescriptor(descriptor, registry(descriptor));
    alias.computer("init", {}, {});
    alias.computer("go", modelValues(), {});
    expect(alias.coverage()).toEqual({ Initialize: 1, Exercise: 1 });
  });

  it("poisons after handler or observer failure and rejects duplicate set/map output", () => {
    const descriptor = richDescriptor();
    const handlerFailure = bindDynamicDescriptor(descriptor, registry(descriptor, {
      actions: { Initialize: () => { throw new Error("boom"); }, Exercise: () => {} },
    }));
    expect(() => handlerFailure.computer("init", {}, {})).toThrow(
      expect.objectContaining({ code: "adapter_failure" }),
    );
    expect(() => handlerFailure.computer("init", {}, {})).toThrow(
      expect.objectContaining({ code: "binding_poisoned" }),
    );

    for (const [id, duplicate] of [
      ["SetValue", [1n, 1n]],
      ["MapValue", [["same", 1n], ["same", 2n]]],
    ] as const) {
      const values = nativeValues();
      values[id] = duplicate as NativeModelValue;
      const invalid = bindDynamicDescriptor(descriptor, registry(descriptor, {
        observations: Object.fromEntries(shapes.map(([observation]) =>
          [observation, () => values[observation]!])),
      }));
      expect(() => invalid.computer("init", {}, {})).toThrow(
        expect.objectContaining({ code: "observation_shape_mismatch" }),
      );
      expect(() => invalid.computer("init", {}, {})).toThrow(
        expect.objectContaining({ code: "binding_poisoned" }),
      );
    }
  });

  it("rejects duplicate set and map keys on input before mutation", () => {
    const descriptor = richDescriptor();
    let calls = 0;
    const binding = bindDynamicDescriptor(descriptor, registry(descriptor, {
      actions: { Initialize: () => {}, Exercise: () => { calls += 1; } },
    }));
    binding.computer("init", {}, {});
    const payload = modelValues();
    payload.MapValue = {
      tag: "map",
      val: [
        [{ tag: "str", val: "same" }, { tag: "int", val: 1n }],
        [{ tag: "str", val: "same" }, { tag: "int", val: 2n }],
      ],
    };
    expect(() => binding.computer("exercise", payload, {})).toThrow(
      expect.objectContaining({ code: "input_shape_mismatch" }),
    );
    expect(calls).toBe(0);
  });

  it("rejects deferred and reentrant callbacks without continuing observation", () => {
    const descriptor = richDescriptor();
    const deferred = bindDynamicDescriptor(descriptor, registry(descriptor, {
      actions: {
        Initialize: (() => Promise.resolve()) as unknown as () => void,
        Exercise: () => {},
      },
    }));
    expect(() => deferred.computer("init", {}, {})).toThrow(
      expect.objectContaining({ code: "adapter_failure" }),
    );
    expect(() => deferred.computer("init", {}, {})).toThrow(
      expect.objectContaining({ code: "binding_poisoned" }),
    );

    let observationCalls = 0;
    let reentrant!: ReturnType<typeof bindDynamicDescriptor>;
    reentrant = bindDynamicDescriptor(descriptor, registry(descriptor, {
      actions: {
        Initialize: () => {
          try {
            reentrant.computer("init", {}, {});
          } catch {
            // A handler cannot neutralize the poison by swallowing this error.
          }
        },
        Exercise: () => {},
      },
      observations: Object.fromEntries(shapes.map(([id]) => [id, () => {
        observationCalls += 1;
        return nativeValues()[id]!;
      }])),
    }));
    expect(() => reentrant.computer("init", {}, {})).toThrow(
      expect.objectContaining({ code: "adapter_failure" }),
    );
    expect(observationCalls).toBe(0);
  });

  it("cannot recover when an observer swallows a reentrant computer error", () => {
    const descriptor = richDescriptor();
    let actionCalls = 0;
    let observerCalls = 0;
    let binding!: ReturnType<typeof bindDynamicDescriptor>;
    const values = nativeValues();
    binding = bindDynamicDescriptor(descriptor, registry(descriptor, {
      actions: {
        Initialize: () => { actionCalls += 1; },
        Exercise: () => { actionCalls += 1; },
      },
      observations: Object.fromEntries(shapes.map(([id], index) => [id, () => {
        observerCalls += 1;
        if (index === 0) {
          try {
            binding.computer("init", {}, {});
          } catch {
            // The outer observation pass must still notice this poison.
          }
        }
        return values[id]!;
      }])),
    }));

    expect(() => binding.computer("init", {}, {})).toThrow(
      expect.objectContaining({ code: "observation_shape_mismatch" }),
    );
    expect(actionCalls).toBe(1);
    expect(observerCalls).toBe(shapes.length);
    expect(binding.coverage()).toEqual({ Initialize: 0, Exercise: 0 });
    expect(() => binding.computer("init", {}, {})).toThrow(
      expect.objectContaining({ code: "binding_poisoned" }),
    );
    expect(actionCalls).toBe(1);
    expect(observerCalls).toBe(shapes.length);
  });

  it("closes over a verified frozen descriptor snapshot", () => {
    const mutable: any = structuredClone(richDescriptor());
    const checked = decodeSemanticDescriptor(mutable);
    const binding = bindDynamicDescriptor(mutable, registry(checked));

    mutable.initializers[0].wireAction = "retargeted";
    mutable.actions[0].inputs[0].type = { kind: "str" };
    mutable.observations = [];

    expect(binding.computer("init", {}, {})).toEqual(modelValues());
    expect(binding.coverage()).toEqual({ Initialize: 1, Exercise: 0 });
    expect(() => binding.computer("retargeted", {}, {})).toThrow(
      expect.objectContaining({ code: "unknown_action" }),
    );
  });

  it("rejects computation immediately after disposal, including concurrent disposal calls", async () => {
    let release!: () => void;
    let calls = 0;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const descriptor = richDescriptor();
    const binding = bindDynamicDescriptor(descriptor, registry(descriptor), () => {
      calls += 1;
      return pending;
    });
    const first = binding.dispose();
    expect(binding.dispose()).toBe(first);
    expect(() => binding.computer("init", {}, {})).toThrow(
      expect.objectContaining({ code: "binding_disposed" }),
    );
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await first;
    expect(binding.dispose()).toBe(first);
  });
});

function descriptorFor(type: ModelType): SemanticDescriptor {
  const descriptor = richDescriptor();
  return decodeSemanticDescriptor({
    ...descriptor,
    actions: [{
      ...descriptor.actions[0],
      inputs: [{ id: "Input", from: { root: "stepParameters", path: [{ field: "input" }] }, type }],
    }],
    observations: [{ id: "Output", wireName: "output", type, provenance: "implementation" }],
  });
}

function roundtripBinding(type: ModelType, initial: NativeModelValue) {
  const descriptor = descriptorFor(type);
  let current = initial;
  let actionCalls = 0;
  const binding = bindDynamicDescriptor(descriptor, {
    semanticDigest: semanticDescriptorDigest(descriptor),
    actions: {
      Initialize: () => {},
      Exercise: (inputs) => { actionCalls += 1; current = inputs.Input!; },
    },
    observations: { Output: () => current },
  });
  return { binding, current: () => current, actionCalls: () => actionCalls };
}

describe("opaque ITF dynamic values", () => {
  const primitive: Value = { tag: "int", val: 123n };
  const nested: Value = {
    tag: "record",
    val: {
      set: { tag: "set", val: [{ tag: "str", val: "first" }, primitive] },
      seq: { tag: "seq", val: [{ tag: "bool", val: true }, { tag: "null" }] },
      tuple: { tag: "tuple", val: [primitive, { tag: "unserializable", val: "opaque-model-value" }] },
      map: { tag: "map", val: [[{ tag: "str", val: "key" }, {
        tag: "variant", variantTag: "Some", value: primitive,
      }]] },
    },
  };
  const wrapped = opaqueItfValue(nested);
  const containers: ReadonlyArray<readonly [string, ModelType, NativeModelValue, Value]> = [
    ["direct", opaque, wrapped, nested],
    ["set", { kind: "set", element: opaque }, [wrapped], { tag: "set", val: [nested] }],
    ["seq", { kind: "seq", element: opaque }, [wrapped], { tag: "seq", val: [nested] }],
    ["tuple", { kind: "tuple", elements: [opaque, bool] }, [wrapped, true], {
      tag: "tuple", val: [nested, { tag: "bool", val: true }],
    }],
    ["record", { kind: "record", fields: [{ wireName: "payload", type: opaque }] },
      { payload: wrapped }, { tag: "record", val: { payload: nested } }],
    ["map key and value", { kind: "map", key: opaque, value: opaque }, [[wrapped, wrapped]],
      { tag: "map", val: [[nested, nested]] }],
    ["variant", { kind: "variant", cases: [{ tag: "Opaque", payload: opaque }] },
      { tag: "Opaque", value: wrapped }, { tag: "variant", variantTag: "Opaque", value: nested }],
  ];

  it.each(containers)("round-trips opaque values under %s", (_name, type, native, model) => {
    const { binding, current } = roundtripBinding(type, native);
    expect(binding.computer("init", {}, {})).toEqual({ output: model });
    expect(binding.computer("go", { input: model }, {})).toEqual({ output: model });
    expect(Object.isFrozen(current())).toBe(true);
    expect(binding.coverage()).toEqual({ Initialize: 1, Exercise: 1 });
  });

  it.each(containers)("rejects malformed nested opaque data under %s before mutation", (_name, type, native, model) => {
    const malformed = structuredClone(model);
    function corruptLeaf(value: Value): boolean {
      if (value.tag === "int") {
        Object.assign(value, { val: "not a bigint" });
        return true;
      }
      if (value.tag === "record") return Object.values(value.val).some(corruptLeaf);
      if (value.tag === "set" || value.tag === "seq" || value.tag === "tuple") {
        return value.val.some(corruptLeaf);
      }
      if (value.tag === "map") return value.val.some(([key, item]) => corruptLeaf(key) || corruptLeaf(item));
      if (value.tag === "variant") return corruptLeaf(value.value);
      return false;
    }
    expect(corruptLeaf(malformed)).toBe(true);
    const { binding, actionCalls } = roundtripBinding(type, native);
    binding.computer("init", {}, {});
    expect(() => binding.computer("go", { input: malformed }, {})).toThrow(
      expect.objectContaining({ code: "input_shape_mismatch" }),
    );
    expect(actionCalls()).toBe(0);
  });

  it("snapshots/freeze-wraps all levels and does not retain mutable or shared aliases", () => {
    const leaf: Value = { tag: "str", val: "original" };
    const source: Value = { tag: "tuple", val: [leaf, leaf] };
    const wrapped = opaqueItfValue(source);
    leaf.val = "changed";
    source.val.push({ tag: "null" });
    expect(wrapped.value).toEqual({ tag: "tuple", val: [
      { tag: "str", val: "original" }, { tag: "str", val: "original" },
    ] });
    expect(Object.isFrozen(wrapped)).toBe(true);
    if (wrapped.value.tag !== "tuple") throw new Error("expected tuple");
    expect(Object.isFrozen(wrapped.value.val)).toBe(true);
    expect(Object.isFrozen(wrapped.value.val[0])).toBe(true);
    expect(wrapped.value.val[0]).not.toBe(wrapped.value.val[1]);
    expect(Reflect.set(wrapped.value.val[0]!, "val", "tampered")).toBe(false);
    expect(OpaqueItfValue.encode(wrapped)).toEqual(wrapped.value);
  });

  it("retains prototype-looking record fields as inert data", () => {
    const fields = Object.create(null) as Record<string, Value>;
    fields.__proto__ = { tag: "str", val: "ordinary field" };
    fields["constructor"] = { tag: "null" };
    const wrapped = opaqueItfValue({ tag: "record", val: fields });
    if (wrapped.value.tag !== "record") throw new Error("expected record");
    expect(Object.getPrototypeOf(wrapped.value.val)).toBeNull();
    expect(Object.keys(wrapped.value.val)).toEqual(["__proto__", "constructor"]);
    expect(wrapped.value.val.__proto__).toEqual({ tag: "str", val: "ordinary field" });
  });

  it("never conflates wrappers with native records or variants and rejects forged wrappers", () => {
    const invalid: Array<readonly [ModelType, NativeModelValue]> = [
      [{ kind: "record", fields: [] }, opaqueItfValue({ tag: "null" })],
      [variant, opaqueItfValue({ tag: "variant", variantTag: "Some", value: primitive })],
      [opaque, { tag: "int", val: 1n }],
      [opaque, { tag: "Some", value: 1n }],
      [opaque, Object.create(OpaqueItfValue.prototype)],
    ];
    for (const [type, value] of invalid) {
      const { binding } = roundtripBinding(type, value);
      expect(() => binding.computer("init", {}, {})).toThrow(
        expect.objectContaining({ code: "observation_shape_mismatch" }),
      );
      expect(() => binding.computer("init", {}, {})).toThrow(
        expect.objectContaining({ code: "binding_poisoned" }),
      );
    }
  });

  it("rejects malformed, cyclic, executable, sparse, or excessive opaque data before mutation", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({ tag: "int" }, "val", {
      enumerable: true, get: () => { getterCalls += 1; return 1n; },
    });
    const arrayAccessor = Object.defineProperty([], "0", {
      enumerable: true, get: () => { getterCalls += 1; return primitive; },
    });
    const cycle: { tag: "seq"; val: unknown[] } = { tag: "seq", val: [] };
    cycle.val.push(cycle);
    let deep: Value = primitive;
    for (let index = 0; index <= OPAQUE_ITF_MAX_DEPTH; index += 1) deep = { tag: "seq", val: [deep] };
    const malformed: unknown[] = [
      { tag: "int", val: 1 }, { tag: "bool", val: "true" }, { tag: "str", val: 1 },
      { tag: "null", val: null }, { tag: "variant", variantTag: 1, value: primitive },
      { tag: "unknown", val: "inert" }, { tag: "map", val: [[primitive]] },
      { tag: "seq", val: [, primitive] }, { tag: "tuple", val: arrayAccessor },
      { tag: "int", val: 1n, [Symbol("hidden")]: () => {} }, accessor,
      Object.assign(Object.create({ inherited: true }), primitive),
      { tag: "record", val: { callback: () => {} } }, cycle, deep,
      { tag: "seq", val: Array.from({ length: OPAQUE_ITF_MAX_NODES }, () => primitive) },
    ];
    for (const value of malformed) {
      expect(() => opaqueItfValue(value as Value)).toThrow();
      const { binding, actionCalls } = roundtripBinding(opaque, wrapped);
      binding.computer("init", {}, {});
      expect(() => binding.computer("exercise", { input: value as Value }, {})).toThrow(
        expect.objectContaining({ code: "input_shape_mismatch" }),
      );
      expect(actionCalls()).toBe(0);
    }
    expect(getterCalls).toBe(0);
  });

  it("preserves canonical set/map uniqueness inside opaque values and outer containers", () => {
    const left: Value = { tag: "set", val: [{ tag: "int", val: 1n }, { tag: "int", val: 2n }] };
    const right: Value = { tag: "set", val: [{ tag: "int", val: 2n }, { tag: "int", val: 1n }] };
    const duplicateSet: Value = { tag: "set", val: [left, right] };
    const duplicateMap: Value = { tag: "map", val: [[left, primitive], [right, { tag: "null" }]] };
    expect(() => opaqueItfValue(duplicateSet)).toThrow("duplicate");
    expect(() => opaqueItfValue(duplicateMap)).toThrow("duplicate");
    for (const [type, native, model] of [
      [{ kind: "set", element: opaque }, [opaqueItfValue(left), opaqueItfValue(right)], duplicateSet],
      [{ kind: "map", key: opaque, value: opaque }, [
        [opaqueItfValue(left), wrapped], [opaqueItfValue(right), wrapped],
      ], duplicateMap],
    ] as const) {
      const output = roundtripBinding(type, native).binding;
      expect(() => output.computer("init", {}, {})).toThrow(
        expect.objectContaining({ code: "observation_shape_mismatch" }),
      );
      const input = roundtripBinding(type, []);
      input.binding.computer("init", {}, {});
      expect(() => input.binding.computer("exercise", { input: model }, {})).toThrow(
        expect.objectContaining({ code: "input_shape_mismatch" }),
      );
      expect(input.actionCalls()).toBe(0);
    }
  });
});
