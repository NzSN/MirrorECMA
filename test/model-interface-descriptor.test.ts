import { readFileSync } from "node:fs";
import {
  MAX_MODEL_INTERFACE_DESCRIPTOR_BYTES,
  MODEL_INTERFACE_COMPARISON_POLICY_VERSION,
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  MODEL_INTERFACE_NEGOTIATION_SCHEMA,
  MODEL_INTERFACE_RESOLVER_SEMANTICS_VERSION,
  canonicalSemanticDescriptorBytes,
  canonicalSemanticDescriptorString,
  decodeModelInterfaceFailure,
  decodeModelInterfaceReply,
  decodeSemanticDescriptor,
  parseSemanticDescriptor,
  semanticDescriptorDigest,
  semanticDigestFromHex,
  type SemanticDescriptor,
} from "../src/model-interface.js";
import {
  DescriptorCache,
  DescriptorCacheError,
} from "../src/descriptor-cache.js";

const COUNTER_DIGEST = "193d6cc187d05c18f02ad483a44f8ad0c1634b02083df241df08b9281b045d1c";
const OTHER_DIGEST = "a".repeat(64);

function counterDescriptorValue(): unknown {
  const lock = JSON.parse(readFileSync(
    new URL("./fixtures/model-interface/counter/Counter.mirror-interface.lock.json", import.meta.url),
    "utf8",
  )) as Record<string, unknown>;
  const {
    contract: _contract,
    semanticDigest: _semanticDigest,
    provenanceDigest: _provenanceDigest,
    provenance: _provenance,
    ...descriptor
  } = lock;
  return { ...descriptor, schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA };
}

function counterDescriptor(): SemanticDescriptor {
  return decodeSemanticDescriptor(counterDescriptorValue());
}

function mutableDescriptor(): any {
  return structuredClone(counterDescriptor());
}

function envelope(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
    status,
    descriptorSchema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
    semanticDigest: `sha256:${COUNTER_DIGEST}`,
    ...overrides,
  };
}

describe("SemanticDescriptor v1 identity", () => {
  it("matches the canonical projection and digest fixed by the Counter lock", () => {
    const descriptor = counterDescriptor();
    const expectedCanonical = '{"actions":[{"id":"Tick","inputs":[{"from":{"path":[{"field":"parameters"},{"field":"stride"}],"root":"stepParameters"},"id":"Stride","type":{"kind":"int"}}],"phase":"transition","wireAction":"tick","wireAliases":[]}],"comparisonPolicyVersion":"mirrors-applyParamVars-filterMeta/v1","initializers":[{"id":"Initialize","inputs":[],"phase":"initialize","wireAction":"init","wireAliases":[]}],"interfaceVersion":"1.0.0","model":{"module":"Counter"},"observations":[{"id":"Count","provenance":"implementation","type":{"kind":"int"},"wireName":"count"}],"resolverSemanticsVersion":"mirrors-model-interface-resolver/v1","runProfile":{"actionVariable":"action_taken","configuredParamVar":"parameters","effectiveParamVars":["parameters"],"itfParamVars":[]},"schema":"mirrors.model-interface-descriptor/v1"}';

    expect(canonicalSemanticDescriptorString(descriptor)).toBe(expectedCanonical);
    expect(canonicalSemanticDescriptorBytes(descriptor).byteLength).toBe(798);
    expect(semanticDescriptorDigest(descriptor)).toBe(COUNTER_DIGEST);
    expect(Object.isFrozen(descriptor.actions[0]!.inputs)).toBe(true);
  });

  it("canonicalizes every set-like descriptor collection", () => {
    const left = mutableDescriptor();
    left.actions[0].wireAliases = ["z", "a"];
    left.actions[0].inputs.push({
      id: "Amount",
      from: { root: "stepParameters", path: [{ field: "amount" }] },
      type: {
        kind: "record",
        fields: [
          { wireName: "z", type: { kind: "int" } },
          { wireName: "a", type: { kind: "bool" } },
        ],
      },
    });
    const right = structuredClone(left);
    right.actions[0].wireAliases.reverse();
    right.actions[0].inputs.reverse();
    right.actions[0].inputs[0].type.fields.reverse();

    expect(canonicalSemanticDescriptorString(decodeSemanticDescriptor(left))).toBe(
      canonicalSemanticDescriptorString(decodeSemanticDescriptor(right)),
    );
  });

  it("matches Lean string escaping without conflating TAB and backslash+t", () => {
    const value = mutableDescriptor();
    value.actions[0].wireAliases = [
      "\\t",
      "\t",
      "\b",
      "\f",
      "\n",
      "\r",
      "\u0000",
      "\"",
      "\\",
      "\u2028",
      "\u2029",
      "😀",
    ];
    const canonical = canonicalSemanticDescriptorString(decodeSemanticDescriptor(value));
    const expectedAliases = String.raw`"wireAliases":["\u0000","\u0008","\u0009","\n","\u000c","\r","\"","\\","\\t"," "," ","😀"]`;

    expect(canonical).toContain(expectedAliases);
    expect(Buffer.from(canonical, "utf8").includes(Buffer.from("\\u0009", "ascii"))).toBe(true);
    expect(canonical).not.toContain('"wireAliases":["\\t"');
  });

  it("uses Lean-compressed literal bytes to order set values and map keys", () => {
    const setValue = mutableDescriptor();
    setValue.actions[0].inputs[0].from.path = [{
      mapKey: {
        kind: "set",
        values: [
          { kind: "str", value: "\t" },
          { kind: "str", value: "\\t" },
        ],
      },
    }];
    const setCanonical = canonicalSemanticDescriptorString(decodeSemanticDescriptor(setValue));
    expect(setCanonical).toContain(String.raw`"path":[{"mapKey":{"kind":"set","values":[{"kind":"str","value":"\\t"},{"kind":"str","value":"\u0009"}]}}]`);

    const mapValue = mutableDescriptor();
    mapValue.actions[0].inputs[0].from.path = [{
      mapKey: {
        kind: "map",
        entries: [
          { key: { kind: "str", value: "\t" }, value: { kind: "int", value: "1" } },
          { key: { kind: "str", value: "\\t" }, value: { kind: "int", value: "2" } },
        ],
      },
    }];
    const mapCanonical = canonicalSemanticDescriptorString(decodeSemanticDescriptor(mapValue));
    expect(mapCanonical).toContain(String.raw`"entries":[{"key":{"kind":"str","value":"\\t"},"value":{"kind":"int","value":"2"}},{"key":{"kind":"str","value":"\u0009"},"value":{"kind":"int","value":"1"}}]`);
  });

  it("strictly rejects duplicate and unknown nested fields", () => {
    const raw = canonicalSemanticDescriptorString(counterDescriptor());
    expect(() => parseSemanticDescriptor(raw.replace(
      '"model":{"module":"Counter"}',
      '"model":{"module":"Counter","module":"Other"}',
    ))).toThrow("duplicate object key 'module'");
    expect(() => parseSemanticDescriptor(raw.replace(
      '"model":{"module":"Counter"}',
      '"model":{"module":"Counter","source":"Counter.tla"}',
    ))).toThrow("unknown field 'source'");
  });

  it.each([
    ["wrong resolver", (value: any) => { value.resolverSemanticsVersion = "resolver/v2"; }, "resolverSemanticsVersion"],
    ["wrong comparison", (value: any) => { value.comparisonPolicyVersion = "comparison/v2"; }, "comparisonPolicyVersion"],
    ["wrong action variable", (value: any) => { value.runProfile.actionVariable = "action"; }, "actionVariable"],
    ["wrong effective params", (value: any) => { value.runProfile.effectiveParamVars = []; }, "effectiveParamVars"],
    ["duplicate ITF param", (value: any) => {
      value.runProfile.itfParamVars = ["parameters", "parameters"];
      value.runProfile.effectiveParamVars = ["parameters"];
    }, "duplicate parameter variable"],
    ["wrong initializer phase", (value: any) => { value.initializers[0].phase = "transition"; }, "phase"],
    ["wrong transition root", (value: any) => { value.actions[0].inputs[0].from.root = "initialState"; }, "from.root"],
    ["duplicate action ID", (value: any) => { value.actions[0].id = "Initialize"; }, "duplicate action ID"],
    ["duplicate wire label", (value: any) => { value.actions[0].wireAction = "init"; }, "duplicate action wire label"],
    ["duplicate observation", (value: any) => { value.observations.push(structuredClone(value.observations[0])); }, "duplicate observation ID"],
    ["non-implementation observation", (value: any) => { value.observations[0].provenance = "oracle"; }, "only 'implementation'"],
    ["invalid stable ID", (value: any) => { value.actions[0].id = "tick"; }, "stable ID"],
    ["empty initializer list", (value: any) => { value.initializers = []; }, "at least one initializer"],
    ["duplicate record field", (value: any) => {
      value.observations[0].type = { kind: "record", fields: [
        { wireName: "x", type: { kind: "int" } },
        { wireName: "x", type: { kind: "bool" } },
      ] };
    }, "duplicate record field"],
    ["duplicate input ID", (value: any) => {
      value.actions[0].inputs.push(structuredClone(value.actions[0].inputs[0]));
    }, "duplicate input ID"],
    ["duplicate observation wire name", (value: any) => {
      value.observations.push({
        ...structuredClone(value.observations[0]),
        id: "OtherObservation",
      });
    }, "duplicate observation wire name"],
  ])("rejects %s", (_label, mutate, expected) => {
    const value = mutableDescriptor();
    mutate(value);
    expect(() => decodeSemanticDescriptor(value)).toThrow(expected);
  });

  it("enforces collection, path, type-depth, node, label, and descriptor-byte limits", () => {
    const initializers = mutableDescriptor();
    initializers.initializers = Array.from({ length: 33 }, () => initializers.initializers[0]);
    expect(() => decodeSemanticDescriptor(initializers)).toThrow("32 initializers");

    const actions = mutableDescriptor();
    actions.actions = Array.from({ length: 257 }, () => actions.actions[0]);
    expect(() => decodeSemanticDescriptor(actions)).toThrow("256 actions");

    const aliases = mutableDescriptor();
    aliases.actions[0].wireAliases = Array.from({ length: 17 }, (_, index) => `alias${index}`);
    expect(() => decodeSemanticDescriptor(aliases)).toThrow("16 aliases");

    const inputs = mutableDescriptor();
    inputs.actions[0].inputs = Array.from({ length: 129 }, (_, index) => ({
      id: `Input${index}`,
      from: { root: "stepParameters", path: [] },
      type: { kind: "int" },
    }));
    expect(() => decodeSemanticDescriptor(inputs)).toThrow("128 inputs");

    const observations = mutableDescriptor();
    observations.observations = Array.from({ length: 1_025 }, () => observations.observations[0]);
    expect(() => decodeSemanticDescriptor(observations)).toThrow("1024 observations");

    const path = mutableDescriptor();
    path.actions[0].inputs[0].from.path = Array.from({ length: 33 }, () => ({ field: "x" }));
    expect(() => decodeSemanticDescriptor(path)).toThrow("32 segments");

    const deep = mutableDescriptor();
    let deepType: any = { kind: "int" };
    for (let index = 0; index < 32; index += 1) deepType = { kind: "set", element: deepType };
    deep.observations[0].type = deepType;
    expect(() => decodeSemanticDescriptor(deep)).toThrow("nesting exceeds 32");

    const nodes = mutableDescriptor();
    nodes.observations[0].type = {
      kind: "tuple",
      elements: Array.from({ length: 8_193 }, () => ({ kind: "int" })),
    };
    expect(() => decodeSemanticDescriptor(nodes)).toThrow("exceeds 8192 nodes");

    const label = mutableDescriptor();
    label.actions[0].wireAction = "é".repeat(129);
    expect(() => decodeSemanticDescriptor(label)).toThrow("256 UTF-8 bytes");

    const oversized = mutableDescriptor();
    oversized.observations = Array.from({ length: 400 }, (_, index) => ({
      id: `Observation${index}`,
      wireName: `observation_${index}_${"x".repeat(30)}`,
      provenance: "implementation",
      type: { kind: "int" },
    }));
    expect(() => decodeSemanticDescriptor(oversized)).toThrow(
      `maximum is ${MAX_MODEL_INTERFACE_DESCRIPTOR_BYTES}`,
    );
  });
});

describe("descriptor negotiation reply and failure codecs", () => {
  it("validates a resolved envelope before returning its descriptor", () => {
    const descriptor = counterDescriptor();
    const decoded = decodeModelInterfaceReply(envelope("resolved", {
      descriptorBytes: canonicalSemanticDescriptorBytes(descriptor).byteLength,
      descriptor,
      provenanceDigest: `sha256:${OTHER_DIGEST}`,
    }));
    expect(decoded).toMatchObject({
      status: "resolved",
      semanticDigest: COUNTER_DIGEST,
      descriptorBytes: 798,
      provenanceDigest: OTHER_DIGEST,
    });
    expect(Object.isFrozen((decoded as any).descriptor)).toBe(true);
  });

  it.each([
    ["matched", {}],
    ["not_modified", {}],
    ["too_large", { descriptorBytes: MAX_MODEL_INTERFACE_DESCRIPTOR_BYTES + 1 }],
    ["mismatch", {}],
    ["unsupported", { descriptorSchema: undefined, semanticDigest: undefined }],
    ["unavailable", { descriptorSchema: undefined, semanticDigest: undefined }],
  ])("decodes the %s reply status", (status, overrides) => {
    expect(decodeModelInterfaceReply(envelope(status, overrides))).toMatchObject({ status });
  });

  it("treats explicit null optionals as absent", () => {
    const decoded = decodeModelInterfaceReply(envelope("not_modified", {
      provenanceDigest: null,
      descriptor: null,
      descriptorBytes: null,
    }));
    expect(decoded).not.toHaveProperty("provenanceDigest");
    expect(decodeModelInterfaceFailure({
      schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
      status: "unsupported",
      code: "unsupported",
      expectedSemanticDigest: null,
      actualSemanticDigest: null,
      provenanceDigest: null,
      descriptorBytes: null,
    })).toEqual({
      kind: "failure",
      schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
      status: "unsupported",
      code: "unsupported",
    });
  });

  it("rejects tampered descriptor identity, byte counts, and status fields", () => {
    const descriptor = counterDescriptor();
    expect(() => decodeModelInterfaceReply(envelope("resolved", {
      descriptorBytes: 797,
      descriptor,
    }))).toThrow("expected 798");
    expect(() => decodeModelInterfaceReply(envelope("resolved", {
      semanticDigest: `sha256:${OTHER_DIGEST}`,
      descriptorBytes: 798,
      descriptor,
    }))).toThrow("does not match canonical descriptor");
    const tampered = mutableDescriptor();
    tampered.interfaceVersion = "1.0.1";
    expect(() => decodeModelInterfaceReply(envelope("resolved", {
      descriptorBytes: canonicalSemanticDescriptorBytes(decodeSemanticDescriptor(tampered)).byteLength,
      descriptor: tampered,
    }))).toThrow("does not match canonical descriptor");
    expect(() => decodeModelInterfaceReply(envelope("matched", { descriptorBytes: 1 }))).toThrow("forbidden for matched");
    expect(() => decodeModelInterfaceReply(envelope("not_modified", { descriptor }))).toThrow("forbidden for not_modified");
    expect(() => decodeModelInterfaceReply(envelope("too_large", { descriptorBytes: undefined }))).toThrow("required for too_large");
    expect(() => decodeModelInterfaceReply(envelope("unsupported"))).toThrow("forbidden for unsupported");
  });

  it.each([
    ["mismatch", { expectedSemanticDigest: `sha256:${COUNTER_DIGEST}` }],
    ["unsupported", {}],
    ["unavailable", {}],
    ["too_large", { descriptorBytes: 40_000 }],
  ])("decodes a structured %s failure", (status, fields) => {
    expect(decodeModelInterfaceFailure({
      schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
      status,
      code: `interface_${status}`,
      ...fields,
    })).toMatchObject({ status, code: `interface_${status}` });
  });

  it("rejects invalid failure combinations", () => {
    expect(() => decodeModelInterfaceFailure({
      schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
      status: "mismatch",
      code: "mismatch",
    })).toThrow("expectedSemanticDigest");
    expect(() => decodeModelInterfaceFailure({
      schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
      status: "too_large",
      code: "too_large",
    })).toThrow("descriptorBytes");
    expect(() => decodeModelInterfaceFailure({
      schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
      status: "resolved",
      code: "wrong",
    })).toThrow("invalid on register_error");
  });
});

describe("DescriptorCache", () => {
  function versioned(version: string): SemanticDescriptor {
    const value = mutableDescriptor();
    value.interfaceVersion = version;
    return decodeSemanticDescriptor(value);
  }

  it("stores only cloned immutable values and returns fresh canonical bytes", () => {
    const source = mutableDescriptor();
    const cache = new DescriptorCache();
    const inserted = cache.put(source);
    source.model.module = "Mutated";
    inserted.canonicalBytes[0] ^= 0xff;

    const hit = cache.require(semanticDigestFromHex(COUNTER_DIGEST));
    expect(hit.descriptor.model.module).toBe("Counter");
    expect(hit.canonicalBytes[0]).toBe("{".charCodeAt(0));
    expect(Object.isFrozen(hit.descriptor)).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.byteSize).toBe(798);
  });

  it("evicts deterministically by completed-entry LRU order", () => {
    const first = counterDescriptor();
    const second = versioned("1.0.1");
    const third = versioned("1.0.2");
    const cache = new DescriptorCache({ maxEntries: 2 });
    const firstDigest = cache.put(first).semanticDigest;
    const secondDigest = cache.put(second).semanticDigest;
    cache.require(firstDigest);
    const thirdDigest = cache.put(third).semanticDigest;

    expect(cache.get(secondDigest)).toBeUndefined();
    expect(cache.require(firstDigest).semanticDigest).toBe(firstDigest);
    expect(cache.require(thirdDigest).semanticDigest).toBe(thirdDigest);
  });

  it("enforces byte quota without inserting an entry that cannot fit", () => {
    const descriptor = counterDescriptor();
    const bytes = canonicalSemanticDescriptorBytes(descriptor).byteLength;
    const rejecting = new DescriptorCache({ maxBytes: bytes - 1 });
    expect(() => rejecting.put(descriptor)).toThrow(DescriptorCacheError);
    expect(rejecting.size).toBe(0);

    const cache = new DescriptorCache({ maxEntries: 10, maxBytes: bytes + 10 });
    const firstDigest = cache.put(descriptor).semanticDigest;
    const secondDigest = cache.put(versioned("1.0.1")).semanticDigest;
    expect(cache.get(firstDigest)).toBeUndefined();
    expect(cache.require(secondDigest).semanticDigest).toBe(secondDigest);
    expect(cache.byteSize).toBeLessThanOrEqual(bytes + 10);
  });

  it("fails closed and quarantines a corrupt completed entry", () => {
    const cache = new DescriptorCache();
    const digest = cache.put(counterDescriptor()).semanticDigest;
    const internal = cache as unknown as {
      entries: Map<string, { canonicalBytes: Uint8Array }>;
    };
    internal.entries.get(digest)!.canonicalBytes[0] ^= 0xff;

    let error: unknown;
    try {
      cache.require(digest);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(DescriptorCacheError);
    expect(error).toMatchObject({ code: "descriptor_cache_corrupt" });
    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
  });

  it("distinguishes a cache miss and exposes the most-recent verified digest", () => {
    const cache = new DescriptorCache();
    const digest = cache.put(counterDescriptor()).semanticDigest;
    expect(cache.mostRecentDigest()).toBe(digest);
    expect(() => cache.require(semanticDigestFromHex(OTHER_DIGEST))).toThrow(
      expect.objectContaining({ code: "descriptor_cache_miss" }),
    );
  });

  it("rejects nonsensical cache quotas", () => {
    expect(() => new DescriptorCache({ maxEntries: 0 })).toThrow("positive safe integer");
    expect(() => new DescriptorCache({ maxBytes: Number.POSITIVE_INFINITY })).toThrow("positive safe integer");
  });
});
