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
import type { State } from "../src/protocol.js";

const int = { kind: "int" } as const;
const bool = { kind: "bool" } as const;
const str = { kind: "str" } as const;
const nil = { kind: "null" } as const;
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

  it("rejects registry mismatch and unsupported types before any callback", () => {
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

    const opaqueValue: any = structuredClone(descriptor);
    opaqueValue.observations[0].type = { kind: "opaqueItf", description: "opaque" };
    const opaque = decodeSemanticDescriptor(opaqueValue);
    expect(() => bindDynamicDescriptor(opaque, registry(opaque))).toThrow(
      expect.objectContaining({ code: "descriptor_type_unsupported" }),
    );
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
});
