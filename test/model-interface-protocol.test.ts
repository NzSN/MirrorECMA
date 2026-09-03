import type { Register, RegisterTraces } from "../src/protocol.js";
import {
  MAX_MODEL_INTERFACE_MESSAGE_BYTES,
  MODEL_INTERFACE_CONTRACT_SCHEMA,
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  MODEL_INTERFACE_NEGOTIATION_SCHEMA,
  ModelInterfaceProtocolError,
  createDescriptorRequest,
  createVerifyRequest,
  decodeContractV1,
  decodeModelInterfaceMirrorMessage,
  encodeModelInterfaceRegistration,
  parseModelInterfaceRequest,
  parseStrictJson,
  parseWireSemanticDigest,
  renderWireSemanticDigest,
  semanticDigestFromHex,
  type ContractV1,
} from "../src/model-interface.js";

const digestHex = "193d6cc187d05c18f02ad483a44f8ad0c1634b02083df241df08b9281b045d1c";
const otherDigestHex = "a".repeat(64);

function counterContract(): ContractV1 {
  return {
    schema: MODEL_INTERFACE_CONTRACT_SCHEMA,
    interfaceVersion: "1.0.0",
    model: { module: "Counter", source: "specs/Counter.tla" },
    wire: { actionVariable: "action_taken", parameterVariable: "parameters" },
    initializers: [{ id: "Initialize", wireAction: "init", wireAliases: [], inputs: [] }],
    actions: [{
      id: "Tick",
      wireAction: "tick",
      wireAliases: ["increment"],
      inputs: [{
        id: "Stride",
        from: {
          root: "stepParameters",
          path: [{ field: "parameters" }, { field: "stride" }],
        },
        expectedType: { kind: "int" },
      }],
    }],
    observations: [{
      id: "Count",
      wireName: "count",
      provenance: "implementation",
      expectedType: { kind: "int" },
    }],
  };
}

function baseRegister(): Register {
  return {
    proto_step: "register",
    apalacheConfig: {
      specPath: "specs/Counter.tla",
      invariant: "TraceComplete",
      lengthBound: 6,
      paramVars: "parameters",
    },
    traceConfig: { numTraces: 1 },
  };
}

function matchedReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    proto_step: "spec_validated",
    result: "valid",
    modelInterface: {
      schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
      status: "matched",
      descriptorSchema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
      semanticDigest: `sha256:${digestHex}`,
      ...overrides,
    },
  });
}

describe("semantic digests", () => {
  it("brands normalized hex and adds the wire prefix only at the boundary", () => {
    const digest = semanticDigestFromHex(digestHex);
    expect(renderWireSemanticDigest(digest)).toBe(`sha256:${digestHex}`);
    expect(parseWireSemanticDigest(`sha256:${digestHex}`)).toBe(digest);
  });

  it.each([
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
  ])("rejects noncanonical normalized digest %p", (value) => {
    expect(() => semanticDigestFromHex(value)).toThrow(ModelInterfaceProtocolError);
  });

  it("rejects a missing or repeated wire prefix", () => {
    expect(() => parseWireSemanticDigest(digestHex)).toThrow("sha256:");
    expect(() => parseWireSemanticDigest(`sha256:sha256:${digestHex}`)).toThrow();
  });
});

describe("ContractV1", () => {
  it("validates, clones, and deeply freezes generated metadata", () => {
    const original = counterContract();
    const request = createVerifyRequest({ semanticDigest: digestHex, contract: original });

    expect(request.expectedSemanticDigest).toBe(digestHex);
    expect(request.contract.inline).not.toBe(original);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.contract.inline.actions)).toBe(true);
    expect(Object.isFrozen(request.contract.inline.actions[0]!.inputs[0]!.from.path)).toBe(true);
  });

  it("accepts every version-1 type and path selector shape", () => {
    const contract = counterContract();
    const rich = {
      ...contract,
      actions: [{
        ...contract.actions[0]!,
        inputs: [{
          id: "Rich",
          from: {
            root: "stepParameters",
            path: [
              { index: 0 },
              { mapKey: { kind: "variant", tag: "Some", payload: { kind: "int", value: "7" } } },
              { variantValue: "Some" },
            ],
          },
          expectedType: {
            kind: "record",
            fields: [{
              wireName: "items",
              type: {
                kind: "map",
                key: { kind: "str" },
                value: {
                  kind: "variant",
                  cases: [{ tag: "Some", payload: { kind: "seq", element: { kind: "bool" } } }],
                },
              },
            }],
          },
        }],
      }],
    };
    expect(decodeContractV1(rich).actions[0]!.inputs[0]!.expectedType?.kind).toBe("record");
  });

  it("rejects unknown versioned fields and unsupported schema versions", () => {
    expect(() => decodeContractV1({ ...counterContract(), typo: true })).toThrow("unknown field 'typo'");
    expect(() => decodeContractV1({ ...counterContract(), schema: "mirrors.model-interface/v2" })).toThrow(
      MODEL_INTERFACE_CONTRACT_SCHEMA,
    );
  });

  it("enforces contract collection and projection limits", () => {
    const contract = counterContract();
    expect(() => decodeContractV1({
      ...contract,
      initializers: Array.from({ length: 33 }, () => contract.initializers[0]),
    })).toThrow("32 initializers");
    expect(() => decodeContractV1({
      ...contract,
      actions: [{
        ...contract.actions[0],
        inputs: [{
          id: "TooDeep",
          from: { root: "stepParameters", path: Array.from({ length: 33 }, () => ({ field: "x" })) },
        }],
      }],
    })).toThrow("32 segments");
  });
});

describe("D3 verify request", () => {
  it("extends a registration without mutating it", () => {
    const base = baseRegister();
    const before = JSON.stringify(base);
    const request = createVerifyRequest({ semanticDigest: digestHex, contract: counterContract() });
    const encoded = encodeModelInterfaceRegistration(base, request);
    const raw = JSON.parse(encoded) as Record<string, any>;

    expect(JSON.stringify(base)).toBe(before);
    expect("modelInterface" in base).toBe(false);
    expect(raw.modelInterface).toMatchObject({
      schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
      request: "verify",
      policy: "require",
      acceptDescriptorSchemas: [MODEL_INTERFACE_DESCRIPTOR_SCHEMA],
      expectedSemanticDigest: `sha256:${digestHex}`,
      contract: { inline: { schema: MODEL_INTERFACE_CONTRACT_SCHEMA } },
    });
    expect(Object.isFrozen(parseModelInterfaceRequest(JSON.stringify(raw.modelInterface)))).toBe(true);
  });

  it("preserves an explicit prefer policy", () => {
    const request = createVerifyRequest(
      { semanticDigest: digestHex, contract: counterContract() },
      "prefer",
    );
    expect(request.policy).toBe("prefer");
  });

  it("extends register_traces and refuses to replace an existing field", () => {
    const base: RegisterTraces = {
      proto_step: "register_traces",
      apalacheConfig: baseRegister().apalacheConfig,
      itfTracePaths: ["counter.itf.json"],
    };
    const request = createVerifyRequest({ semanticDigest: digestHex, contract: counterContract() });
    expect(JSON.parse(encodeModelInterfaceRegistration(base, request))).toMatchObject({
      proto_step: "register_traces",
      itfTracePaths: ["counter.itf.json"],
      modelInterface: { request: "verify" },
    });
    const alreadyExtended = { ...base, modelInterface: {} } as unknown as RegisterTraces;
    expect(() => encodeModelInterfaceRegistration(alreadyExtended, request)).toThrow("already present");
  });

  it("keeps verify strict while the generic codec accepts descriptor mode", () => {
    const request = JSON.parse(encodeModelInterfaceRegistration(
      baseRegister(),
      createVerifyRequest({ semanticDigest: digestHex, contract: counterContract() }),
    )).modelInterface;
    expect(parseModelInterfaceRequest(JSON.stringify({ ...request, request: "descriptor" }))).toMatchObject(
      { request: "descriptor", expectedSemanticDigest: digestHex },
    );
    expect(() => parseModelInterfaceRequest(JSON.stringify({ ...request, ifNoneMatch: `sha256:${digestHex}` }))).toThrow(
      "allowed only for descriptor requests",
    );
    expect(() => parseModelInterfaceRequest(JSON.stringify({ ...request, expectedSemanticDigest: digestHex }))).toThrow(
      "sha256:",
    );
    expect(() => parseModelInterfaceRequest(JSON.stringify({ ...request, typo: true }))).toThrow("unknown field 'typo'");
    expect(() => parseModelInterfaceRequest(JSON.stringify({
      ...request,
      contract: { digest: `sha256:${digestHex}` },
    }))).toThrow("digest contract references are unsupported");
  });

  it("creates descriptor requests with optional digest validators", () => {
    const digest = semanticDigestFromHex(digestHex);
    const request = createDescriptorRequest(counterContract(), {
      policy: "prefer",
      expectedSemanticDigest: digest,
      ifNoneMatch: digest,
    });
    expect(request).toMatchObject({
      request: "descriptor",
      policy: "prefer",
      expectedSemanticDigest: digestHex,
      ifNoneMatch: digestHex,
    });
    const encoded = JSON.parse(encodeModelInterfaceRegistration(baseRegister(), request));
    expect(encoded.modelInterface).toMatchObject({
      request: "descriptor",
      expectedSemanticDigest: `sha256:${digestHex}`,
      ifNoneMatch: `sha256:${digestHex}`,
    });
    expect(parseModelInterfaceRequest(JSON.stringify({
      ...encoded.modelInterface,
      expectedSemanticDigest: null,
      ifNoneMatch: null,
    }))).not.toHaveProperty("expectedSemanticDigest");

    const unpinned = createDescriptorRequest(counterContract());
    expect(unpinned).toMatchObject({ request: "descriptor", policy: "require" });
    expect(unpinned).not.toHaveProperty("expectedSemanticDigest");
    expect(unpinned).not.toHaveProperty("ifNoneMatch");
  });

  it("enforces accepted descriptor schema bounds and uniqueness", () => {
    const request = JSON.parse(encodeModelInterfaceRegistration(
      baseRegister(),
      createVerifyRequest({ semanticDigest: digestHex, contract: counterContract() }),
    )).modelInterface;
    expect(() => parseModelInterfaceRequest(JSON.stringify({ ...request, acceptDescriptorSchemas: [] }))).toThrow("at least one");
    expect(() => parseModelInterfaceRequest(JSON.stringify({ ...request, acceptDescriptorSchemas: ["v1", "v1"] }))).toThrow("duplicate schema");
    expect(() => parseModelInterfaceRequest(JSON.stringify({
      ...request,
      acceptDescriptorSchemas: Array.from({ length: 9 }, (_, index) => `v${index}`),
    }))).toThrow("at most eight");
  });
});

describe("strict raw JSON", () => {
  it("rejects duplicate keys before JSON.parse can collapse them", () => {
    expect(() => parseStrictJson('{"policy":"require","policy":"prefer"}')).toThrow("duplicate object key");
    expect(() => parseStrictJson('{"a":1,"\\u0061":2}')).toThrow("duplicate object key");
    expect(() => decodeModelInterfaceMirrorMessage(
      `{"proto_step":"spec_validated","result":"valid","modelInterface":{"schema":"${MODEL_INTERFACE_NEGOTIATION_SCHEMA}","status":"matched","status":"unavailable"}}`,
    )).toThrow("duplicate object key");
  });

  it("enforces the decoded UTF-8 byte bound", () => {
    const oversized = JSON.stringify({ value: "é".repeat(MAX_MODEL_INTERFACE_MESSAGE_BYTES) });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_MODEL_INTERFACE_MESSAGE_BYTES);
    expect(() => parseStrictJson(oversized)).toThrow(`maximum is ${MAX_MODEL_INTERFACE_MESSAGE_BYTES}`);
  });

  it("enforces depth and rejects malformed surrogate escapes", () => {
    expect(() => parseStrictJson("[".repeat(129) + "0" + "]".repeat(129))).toThrow("nesting exceeds 128");
    expect(() => parseStrictJson('"\\ud800"')).toThrow("high surrogate");
    expect(parseStrictJson('"\\ud83d\\ude00"')).toBe("😀");
  });
});

describe("first mirror reply decoding", () => {
  it("validates matched negotiation and delegates the ordinary message", () => {
    const decoded = decodeModelInterfaceMirrorMessage(matchedReply());
    expect(decoded.message).toEqual({ proto_step: "spec_validated", result: "valid" });
    expect(decoded.modelInterface).toEqual({
      kind: "reply",
      schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
      status: "matched",
      descriptorSchema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
      semanticDigest: digestHex,
    });
    expect(Object.isFrozen(decoded.modelInterface)).toBe(true);
  });

  it("preserves legacy replies as an absent negotiation result", () => {
    expect(decodeModelInterfaceMirrorMessage(
      '{"proto_step":"spec_validated","result":"valid"}',
    )).toEqual({ message: { proto_step: "spec_validated", result: "valid" } });
  });

  it.each(["unsupported", "unavailable"] as const)("accepts a preferred %s reply", (status) => {
    const decoded = decodeModelInterfaceMirrorMessage(JSON.stringify({
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: { schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA, status },
    }));
    expect(decoded.modelInterface).toMatchObject({ kind: "reply", status });
  });

  it("accepts explicit null optional fields", () => {
    const decoded = decodeModelInterfaceMirrorMessage(matchedReply({ provenanceDigest: null }));
    expect(decoded.modelInterface).not.toHaveProperty("provenanceDigest");
  });

  it("rejects malformed or unknown reply fields", () => {
    expect(() => decodeModelInterfaceMirrorMessage(matchedReply({ semanticDigest: digestHex }))).toThrow("sha256:");
    expect(() => decodeModelInterfaceMirrorMessage(matchedReply({ descriptorBytes: 1 }))).toThrow("forbidden for matched");
    expect(() => decodeModelInterfaceMirrorMessage(matchedReply({ extra: true }))).toThrow("unknown field 'extra'");
    expect(() => decodeModelInterfaceMirrorMessage(matchedReply({ status: "resolved" }))).toThrow("required for resolved");
    expect(() => decodeModelInterfaceMirrorMessage(JSON.stringify({
      ...JSON.parse(matchedReply()),
      result: { invalid: "bad spec" },
    }))).toThrow("requires a valid specification result");
  });

  it("decodes a structured mismatch failure", () => {
    const decoded = decodeModelInterfaceMirrorMessage(JSON.stringify({
      proto_step: "register_error",
      error: "model interface digest mismatch",
      modelInterface: {
        schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
        status: "mismatch",
        code: "interface_digest_mismatch",
        expectedSemanticDigest: `sha256:${digestHex}`,
        actualSemanticDigest: `sha256:${otherDigestHex}`,
      },
    }));
    expect(decoded.message).toEqual({ proto_step: "register_error", error: "model interface digest mismatch" });
    expect(decoded.modelInterface).toMatchObject({
      kind: "failure",
      status: "mismatch",
      code: "interface_digest_mismatch",
      expectedSemanticDigest: digestHex,
      actualSemanticDigest: otherDigestHex,
    });
  });

  it("rejects malformed structured failures", () => {
    const failure = {
      proto_step: "register_error",
      error: "failed",
      modelInterface: {
        schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA,
        status: "mismatch",
        code: "interface_digest_mismatch",
      },
    };
    expect(() => decodeModelInterfaceMirrorMessage(JSON.stringify(failure))).toThrow("required for mismatch");
    expect(() => decodeModelInterfaceMirrorMessage(JSON.stringify({
      ...failure,
      modelInterface: { ...failure.modelInterface, status: "matched", expectedSemanticDigest: `sha256:${digestHex}` },
    }))).toThrow("invalid on register_error");
  });

  it("rejects the extension on an unrelated protocol message", () => {
    expect(() => decodeModelInterfaceMirrorMessage(JSON.stringify({
      proto_step: "initial_state",
      action: "init",
      state: {},
      modelInterface: { schema: MODEL_INTERFACE_NEGOTIATION_SCHEMA, status: "matched" },
    }))).toThrow("allowed only on spec_validated or register_error");
  });
});
