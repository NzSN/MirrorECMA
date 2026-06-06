import {
  type Value,
  type State,
  type ClientMessage,
  type MirrorMessage,
  encodeClientMessage,
  encodeState,
  decodeMirrorMessage,
  asInt,
  asStr,
  asRecord,
  getParam,
  getParamInt,
} from "../src/protocol.js";

function roundTrip(msg: ClientMessage): MirrorMessage {
  return decodeMirrorMessage(encodeClientMessage(msg));
}

describe("encodeClientMessage / decodeMirrorMessage", () => {
  it("round-trips a register message", () => {
    const msg: ClientMessage = {
      proto_step: "register",
      specPath: "/foo/bar.tla",
      traceConfig: {
        invariant: "TraceComplete",
        lengthBound: 5,
        numTraces: 10,
      },
    };
    const encoded = encodeClientMessage(msg);
    expect(JSON.parse(encoded)).toMatchObject({
      proto_step: "register",
      specPath: "/foo/bar.tla",
      traceConfig: { invariant: "TraceComplete", lengthBound: 5, numTraces: 10 },
    });
  });

  it("encodes a register_traces message", () => {
    const msg: ClientMessage = {
      proto_step: "register_traces",
      itfTracePaths: ["/tmp/trace1.itf.json", "/tmp/trace2.itf.json"],
    };
    const encoded = encodeClientMessage(msg);
    expect(JSON.parse(encoded)).toEqual({
      proto_step: "register_traces",
      itfTracePaths: ["/tmp/trace1.itf.json", "/tmp/trace2.itf.json"],
    });
  });

  it("round-trips a report_state message with bigints", () => {
    const state: State = {
      count: { tag: "int", val: BigInt("9007199254740991") },
      flag: { tag: "bool", val: true },
    };
    const msg: ClientMessage = {
      proto_step: "report_state",
      state,
    };
    const encoded = encodeClientMessage(msg);
    const parsed = JSON.parse(encoded);
    expect(parsed.state.count).toEqual({ tag: "int", val: { "#bigint": "9007199254740991" } });
    expect(parsed.state.flag).toEqual({ tag: "bool", val: true });
  });
});

describe("decodeMirrorMessage", () => {
  it("decodes spec_validated (valid)", () => {
    const line = JSON.stringify({ proto_step: "spec_validated", result: "valid" });
    const msg = decodeMirrorMessage(line);
    expect(msg).toEqual({ proto_step: "spec_validated", result: "valid" });
  });

  it("decodes spec_validated (invalid)", () => {
    const line = JSON.stringify({ proto_step: "spec_validated", result: { invalid: "bad spec" } });
    const msg = decodeMirrorMessage(line);
    expect(msg).toEqual({
      proto_step: "spec_validated",
      result: { invalid: JSON.stringify({ invalid: "bad spec" }) },
    });
  });

  it("decodes initial_state", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: { count: 0 },
    });
    const msg = decodeMirrorMessage(line);
    expect(msg.proto_step).toBe("initial_state");
    expect((msg as any).action).toBe("Init");
    expect((msg as any).state).toEqual({ count: { tag: "int", val: BigInt(0) } });
  });

  it("decodes next_step", () => {
    const line = JSON.stringify({
      proto_step: "next_step",
      action: "Incr",
      parameters: { by: 1 },
    });
    const msg = decodeMirrorMessage(line);
    expect(msg.proto_step).toBe("next_step");
    expect((msg as any).action).toBe("Incr");
    expect((msg as any).parameters).toEqual({ by: { tag: "int", val: BigInt(1) } });
  });

  it("decodes step_ok", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "step_ok" }));
    expect(msg).toEqual({ proto_step: "step_ok" });
  });

  it("decodes step_mismatch", () => {
    const line = JSON.stringify({
      proto_step: "step_mismatch",
      action: "Inc",
      expected: { count: 1 },
      actual: { count: 2 },
    });
    const msg = decodeMirrorMessage(line);
    expect(msg.proto_step).toBe("step_mismatch");
    const sm = msg as any;
    expect(sm.action).toBe("Inc");
    expect(sm.expected).toEqual({ count: { tag: "int", val: BigInt(1) } });
    expect(sm.actual).toEqual({ count: { tag: "int", val: BigInt(2) } });
  });

  it("decodes all_steps_done", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "all_steps_done" }));
    expect(msg).toEqual({ proto_step: "all_steps_done" });
  });

  it("decodes protocol_error", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "protocol_error", error: "bad!" }));
    expect(msg).toEqual({ proto_step: "protocol_error", error: "bad!" });
  });

  it("decodes register_error", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "register_error", error: "spec not found" }));
    expect(msg).toEqual({ proto_step: "register_error", error: "spec not found" });
  });

  it("returns protocol_error for unknown proto_step", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "unknown_thing", x: 1 }));
    expect(msg).toEqual({
      proto_step: "protocol_error",
      error: "unknown proto_step: unknown_thing",
    });
  });
});

describe("encodeState / decodeMirrorMessage round-trip", () => {
  it("encodes and decodes #bigint values correctly", () => {
    const state: State = { count: { tag: "int", val: BigInt("12345678901234567890") } };
    const encoded = JSON.stringify({ proto_step: "initial_state", action: "Init", state: encodeState(state) });
    const decoded = decodeMirrorMessage(encoded) as any;
    expect(decoded.state.count).toEqual({
      tag: "int",
      val: BigInt("12345678901234567890"),
    });
  });

  it("handles large bigint values", () => {
    const huge = BigInt("999999999999999999999999999999");
    const state: State = { x: { tag: "int", val: huge } };
    const encoded = JSON.stringify({ proto_step: "initial_state", action: "Init", state: encodeState(state) });
    expect(JSON.parse(encoded).state.x).toEqual({ "#bigint": String(huge) });
  });
});

describe("value helpers", () => {
  describe("asInt", () => {
    it("extracts int value", () => {
      expect(asInt({ tag: "int", val: BigInt(42) })).toBe(BigInt(42));
    });

    it("returns null for non-int", () => {
      expect(asInt({ tag: "bool", val: true })).toBeNull();
      expect(asInt({ tag: "str", val: "hi" })).toBeNull();
      expect(asInt({ tag: "null" })).toBeNull();
    });
  });

  describe("asStr", () => {
    it("extracts string value", () => {
      expect(asStr({ tag: "str", val: "hello" })).toBe("hello");
    });

    it("returns null for non-str", () => {
      expect(asStr({ tag: "int", val: BigInt(1) })).toBeNull();
      expect(asStr({ tag: "bool", val: false })).toBeNull();
    });
  });

  describe("asRecord", () => {
    it("extracts record value", () => {
      const rec = asRecord({ tag: "record", val: { a: { tag: "int", val: BigInt(1) } } });
      expect(rec).toEqual({ a: { tag: "int", val: BigInt(1) } });
    });

    it("returns null for non-record", () => {
      expect(asRecord({ tag: "int", val: BigInt(1) })).toBeNull();
      expect(asRecord({ tag: "null" })).toBeNull();
    });
  });
});

describe("getParam / getParamInt", () => {
  const params: State = {
    x: { tag: "record", val: { foo: { tag: "int", val: BigInt(42) } } },
    y: { tag: "int", val: BigInt(7) },
  };

  it("getParam extracts nested record", () => {
    const rec = getParam(params, "x");
    expect(rec).toEqual({ foo: { tag: "int", val: BigInt(42) } });
  });

  it("getParam returns null for non-record", () => {
    expect(getParam(params, "y")).toBeNull();
  });

  it("getParam returns null for missing key", () => {
    expect(getParam(params, "missing")).toBeNull();
  });

  it("getParamInt extracts nested int", () => {
    expect(getParamInt(params, "x", "foo")).toBe(42);
  });

  it("getParamInt returns 0 for missing param", () => {
    expect(getParamInt(params, "missing", "foo")).toBe(0);
  });

  it("getParamInt returns 0 for missing field", () => {
    expect(getParamInt(params, "x", "bar")).toBe(0);
  });
});

describe("value encoding round-trip via initial_state", () => {
  it("decodes boolean values", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: { ready: true, done: false },
    });
    const msg = decodeMirrorMessage(line) as any;
    expect(msg.state.ready).toEqual({ tag: "bool", val: true });
    expect(msg.state.done).toEqual({ tag: "bool", val: false });
  });

  it("decodes string values", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: { name: "alice" },
    });
    const msg = decodeMirrorMessage(line) as any;
    expect(msg.state.name).toEqual({ tag: "str", val: "alice" });
  });

  it("decodes null values", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: { nothing: null },
    });
    const msg = decodeMirrorMessage(line) as any;
    expect(msg.state.nothing).toEqual({ tag: "null" });
  });

  it("decodes nested records", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: {
        person: { name: "bob", age: 30 },
      },
    });
    const msg = decodeMirrorMessage(line) as any;
    expect(msg.state.person).toEqual({
      tag: "record",
      val: {
        name: { tag: "str", val: "bob" },
        age: { tag: "int", val: BigInt(30) },
      },
    });
  });

  it("decodes tuple values", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: {
        pair: { "#tup": ["foo", 7] },
      },
    });
    const msg = decodeMirrorMessage(line) as any;
    expect(msg.state.pair).toEqual({
      tag: "tuple",
      val: [{ tag: "str", val: "foo" }, { tag: "int", val: BigInt(7) }],
    });
  });

  it("decodes set values (arrays)", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: {
        items: [1, 2, 3],
      },
    });
    const msg = decodeMirrorMessage(line) as any;
    expect(msg.state.items).toEqual({
      tag: "set",
      val: [
        { tag: "int", val: BigInt(1) },
        { tag: "int", val: BigInt(2) },
        { tag: "int", val: BigInt(3) },
      ],
    });
  });
});
