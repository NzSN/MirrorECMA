import {
  type Value,
  type State,
  type ClientMessage,
  type MirrorMessage,
  type ApalacheConfig,
  type StepMismatch,
  type DiffHint,
  encodeClientMessage,
  encodeState,
  decodeMirrorMessage,
  asInt,
  asStr,
  asRecord,
  getParam,
  getParamInt,
  renderPath,
  renderDiffHint,
  renderDiffHints,
} from "../src/protocol.js";

function roundTrip(msg: ClientMessage): MirrorMessage {
  return decodeMirrorMessage(encodeClientMessage(msg));
}

describe("encodeClientMessage / decodeMirrorMessage", () => {
  it("round-trips a register message", () => {
    const msg: ClientMessage = {
      proto_step: "register",
      apalacheConfig: {
        specPath: "/foo/bar.tla",
        invariant: "TraceComplete",
        lengthBound: 5,
      },
      traceConfig: {
        numTraces: 10,
      },
    };
    const encoded = encodeClientMessage(msg);
    expect(JSON.parse(encoded)).toMatchObject({
      proto_step: "register",
      apalacheConfig: { specPath: "/foo/bar.tla", invariant: "TraceComplete", lengthBound: 5 },
      traceConfig: { numTraces: 10 },
    });
  });

  it("encodes a register_traces message", () => {
    const msg: ClientMessage = {
      proto_step: "register_traces",
      apalacheConfig: {
        specPath: "/foo/bar.tla",
        invariant: "TraceComplete",
        lengthBound: 5,
      },
      itfTracePaths: ["/tmp/trace1.itf.json", "/tmp/trace2.itf.json"],
    };
    const encoded = encodeClientMessage(msg);
    expect(JSON.parse(encoded)).toEqual({
      proto_step: "register_traces",
      apalacheConfig: { specPath: "/foo/bar.tla", invariant: "TraceComplete", lengthBound: 5 },
      itfTracePaths: ["/tmp/trace1.itf.json", "/tmp/trace2.itf.json"],
    });
  });

  it("round-trips a register message with inline spec", () => {
    const msg: ClientMessage = {
      proto_step: "register",
      apalacheConfig: {
        specPath: "/nonexistent/ExtMain.tla",
        invariant: "TraceComplete",
        lengthBound: 3,
      },
      traceConfig: { numTraces: 1 },
      spec: { sources: ["---- MODULE ExtMain ----\n====\n", "---- MODULE ExtDep ----\n====\n"] },
    };
    const parsed = JSON.parse(encodeClientMessage(msg));
    expect(parsed.spec.sources).toHaveLength(2);
    expect(parsed.spec.sources[0]).toContain("MODULE ExtMain");
  });

  it("omits spec from register when not provided", () => {
    const msg: ClientMessage = {
      proto_step: "register",
      apalacheConfig: { specPath: "/foo.tla", invariant: "Inv", lengthBound: 1 },
      traceConfig: { numTraces: 1 },
    };
    expect("spec" in JSON.parse(encodeClientMessage(msg))).toBe(false);
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
      result: { invalid: "bad spec" },
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

  it("decodes step_mismatch hints", () => {
    const line = JSON.stringify({
      proto_step: "step_mismatch",
      expected: { x: { rec: [1, 2] } },
      actual: { x: { rec: [1, 3] }, y: "extra" },
      hints: [
        {
          kind: "value_mismatch",
          path: [{ field: "x" }, { field: "rec" }, { index: 1 }],
          expected: 2,
          actual: 3,
        },
        { kind: "extra", path: [{ field: "y" }], actual: "extra" },
        { kind: "missing", path: [{ field: "z" }], expected: true },
        { kind: "missing_elem", path: [{ field: "s" }], expected: 7 },
        { kind: "extra_elem", path: [{ field: "s" }], actual: 8 },
        { kind: "truncated", path: [{ field: "big" }] },
      ],
    });
    const msg = decodeMirrorMessage(line);
    expect(msg.proto_step).toBe("step_mismatch");
    const sm = msg as StepMismatch;
    expect(sm.hints).toHaveLength(6);
    expect(sm.hints![0]).toEqual({
      kind: "value_mismatch",
      path: [{ field: "x" }, { field: "rec" }, { index: 1 }],
      expected: { tag: "int", val: BigInt(2) },
      actual: { tag: "int", val: BigInt(3) },
    });
    expect(sm.hints![1]).toEqual({
      kind: "extra",
      path: [{ field: "y" }],
      actual: { tag: "str", val: "extra" },
    });
    expect(sm.hints![2]).toEqual({
      kind: "missing",
      path: [{ field: "z" }],
      expected: { tag: "bool", val: true },
    });
    expect(sm.hints![3]).toEqual({
      kind: "missing_elem",
      path: [{ field: "s" }],
      expected: { tag: "int", val: BigInt(7) },
    });
    expect(sm.hints![4]).toEqual({
      kind: "extra_elem",
      path: [{ field: "s" }],
      actual: { tag: "int", val: BigInt(8) },
    });
    expect(sm.hints![5]).toEqual({ kind: "truncated", path: [{ field: "big" }] });
  });

  it("renders diff hints", () => {
    const hints: DiffHint[] = [
      {
        kind: "value_mismatch",
        path: [{ field: "x" }, { field: "rec" }, { index: 1 }],
        expected: { tag: "int", val: BigInt(2) },
        actual: { tag: "int", val: BigInt(3) },
      },
      { kind: "extra", path: [{ field: "y" }], actual: { tag: "str", val: "hi" } },
      { kind: "missing", path: [{ field: "z" }], expected: { tag: "bool", val: true } },
      { kind: "missing_elem", path: [{ field: "s" }], expected: { tag: "int", val: BigInt(7) } },
      { kind: "extra_elem", path: [{ field: "s" }], actual: { tag: "int", val: BigInt(8) } },
      { kind: "truncated", path: [{ field: "big" }] },
    ];
    expect(renderDiffHint(hints[0])).toBe("at x.rec[1]: expected 2, got 3");
    expect(renderDiffHint(hints[1])).toBe('at y: unexpected "hi"');
    expect(renderDiffHint(hints[2])).toBe("at z: missing true");
    expect(renderDiffHint(hints[3])).toBe("at s: missing element 7");
    expect(renderDiffHint(hints[4])).toBe("at s: unexpected element 8");
    expect(renderDiffHint(hints[5])).toBe("at big: further differences truncated");
    expect(renderDiffHints(hints)).toBe(
      'at x.rec[1]: expected 2, got 3; at y: unexpected "hi"; at z: missing true; at s: missing element 7; at s: unexpected element 8; at big: further differences truncated'
    );
    expect(renderDiffHints([])).toBe("states differ");
    expect(renderPath([])).toBe("<state>");
  });

  it("decodes step_mismatch without hints (legacy mirror)", () => {
    const line = JSON.stringify({
      proto_step: "step_mismatch",
      expected: { count: 1 },
      actual: { count: 2 },
    });
    const msg = decodeMirrorMessage(line) as StepMismatch;
    expect(msg.hints).toBeUndefined();
  });

  it("decodes all_steps_done", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "all_steps_done" }));
    expect(msg).toEqual({ proto_step: "all_steps_done" });
  });
  it("decodes gen_traces_done", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "gen_traces_done", itfTracePaths: ["/tmp/t1.itf.json"] }));
    expect(msg).toEqual({ proto_step: "gen_traces_done", itfTracePaths: ["/tmp/t1.itf.json"], itfTraces: undefined });
  });

  it("decodes gen_traces_done with inline traces, raw passthrough", () => {
    const trace = { vars: ["x"], states: [{ x: { "#bigint": "1" } }] };
    const msg = decodeMirrorMessage(JSON.stringify({
      proto_step: "gen_traces_done",
      itfTracePaths: ["/tmp/t1.itf.json"],
      itfTraces: [trace],
    }));
    expect(msg.proto_step).toBe("gen_traces_done");
    const g = msg as any;
    expect(g.itfTraces).toHaveLength(1);
    // raw ITF JSON must pass through untransformed (no #bigint decoding)
    expect(g.itfTraces[0]).toEqual(trace);
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

describe("explore messages (encode)", () => {
  const spec = { sources: ["---- MODULE M ----\n===="] };

  it("encodes register_explore", () => {
    const encoded = encodeClientMessage({
      proto_step: "register_explore",
      spec,
      invariants: ["Inv"],
      exports: [],
      maxSteps: 4,
    });
    expect(JSON.parse(encoded)).toEqual({
      proto_step: "register_explore",
      spec,
      invariants: ["Inv"],
      exports: [],
      maxSteps: 4,
    });
  });

  it("encodes register_explore_session", () => {
    const encoded = encodeClientMessage({
      proto_step: "register_explore_session",
      spec,
      invariants: ["Inv"],
      exports: [],
    });
    expect(JSON.parse(encoded)).toEqual({
      proto_step: "register_explore_session",
      spec,
      invariants: ["Inv"],
      exports: [],
    });
  });

  it("encodes explore_assume_transition", () => {
    expect(JSON.parse(encodeClientMessage({ proto_step: "explore_assume_transition", transitionId: 3 })))
      .toEqual({ proto_step: "explore_assume_transition", transitionId: 3 });
  });

  it("encodes explore_next_step", () => {
    expect(JSON.parse(encodeClientMessage({ proto_step: "explore_next_step" })))
      .toEqual({ proto_step: "explore_next_step" });
  });

  it("encodes explore_query_state", () => {
    expect(JSON.parse(encodeClientMessage({ proto_step: "explore_query_state" })))
      .toEqual({ proto_step: "explore_query_state" });
  });

  it("encodes explore_check_invariant", () => {
    expect(JSON.parse(encodeClientMessage({ proto_step: "explore_check_invariant", invariantId: 2 })))
      .toEqual({ proto_step: "explore_check_invariant", invariantId: 2 });
  });

  it("encodes explore_rollback", () => {
    expect(JSON.parse(encodeClientMessage({ proto_step: "explore_rollback", snapshotId: 5 })))
      .toEqual({ proto_step: "explore_rollback", snapshotId: 5 });
  });

  it("encodes explore_done", () => {
    expect(JSON.parse(encodeClientMessage({ proto_step: "explore_done" })))
      .toEqual({ proto_step: "explore_done" });
  });
});

describe("decodeMirrorMessage (explorer)", () => {
  it("decodes explorer_ready", () => {
    const msg = decodeMirrorMessage(JSON.stringify({
      proto_step: "explorer_ready",
      initTransitions: 1,
      nextTransitions: 2,
      stateInvariants: 1,
    }));
    expect(msg).toEqual({
      proto_step: "explorer_ready",
      initTransitions: 1,
      nextTransitions: 2,
      stateInvariants: 1,
    });
  });

  it("decodes explore_transition_status", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "explore_transition_status", status: "ENABLED" }));
    expect(msg).toEqual({ proto_step: "explore_transition_status", status: "ENABLED" });
  });

  it("decodes explore_step_done", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "explore_step_done", stepNo: 1 }));
    expect(msg).toEqual({ proto_step: "explore_step_done", stepNo: 1 });
  });

  it("decodes explore_state with #bigint fields", () => {
    const msg = decodeMirrorMessage(JSON.stringify({
      proto_step: "explore_state",
      state: { hr: { "#bigint": "7" }, ticked: true },
    }));
    expect(msg).toEqual({
      proto_step: "explore_state",
      state: {
        hr: { tag: "int", val: 7n },
        ticked: { tag: "bool", val: true },
      },
    });
  });

  it("decodes explore_invariant_status", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "explore_invariant_status", status: "SATISFIED" }));
    expect(msg).toEqual({ proto_step: "explore_invariant_status", status: "SATISFIED" });
  });

  it("decodes explore_assume_status", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "explore_assume_status", status: "DISABLED" }));
    expect(msg).toEqual({ proto_step: "explore_assume_status", status: "DISABLED" });
  });

  it("decodes explore_rollback_done", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "explore_rollback_done", snapshotId: 0 }));
    expect(msg).toEqual({ proto_step: "explore_rollback_done", snapshotId: 0 });
  });

  it("decodes explore_session_done", () => {
    const msg = decodeMirrorMessage(JSON.stringify({ proto_step: "explore_session_done" }));
    expect(msg).toEqual({ proto_step: "explore_session_done" });
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

  it("decodes plain arrays as seq", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: {
        items: [1, 2, 3],
      },
    });
    const msg = decodeMirrorMessage(line) as any;
    expect(msg.state.items).toEqual({
      tag: "seq",
      val: [
        { tag: "int", val: BigInt(1) },
        { tag: "int", val: BigInt(2) },
        { tag: "int", val: BigInt(3) },
      ],
    });
  });

  it("decodes set values (#set format)", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: { items: { "#set": [1, 2, 3] } },
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

  it("decodes map values (#map format)", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: { fun: { "#map": [["a", 1], ["b", 2]] } },
    });
    const msg = decodeMirrorMessage(line) as any;
    expect(msg.state.fun).toEqual({
      tag: "map",
      val: [
        [{ tag: "str", val: "a" }, { tag: "int", val: BigInt(1) }],
        [{ tag: "str", val: "b" }, { tag: "int", val: BigInt(2) }],
      ],
    });
  });

  it("encodes map with #map wrapper", () => {
    const state: State = {
      fun: {
        tag: "map",
        val: [[{ tag: "str", val: "a" }, { tag: "int", val: BigInt(1) }]],
      },
    };
    const encoded = encodeState(state);
    expect(encoded.fun).toEqual({ "#map": [["a", { "#bigint": "1" }]] });
  });

  it("decodes variant values", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: { v: { tag: "Some", value: 42 } },
    });
    const msg = decodeMirrorMessage(line) as any;
    expect(msg.state.v).toEqual({
      tag: "variant",
      variantTag: "Some",
      value: { tag: "int", val: BigInt(42) },
    });
  });

  it("encodes variant values", () => {
    const state: State = {
      v: { tag: "variant", variantTag: "None", value: { tag: "null" } },
    };
    const encoded = encodeState(state);
    expect(encoded.v).toEqual({ tag: "None", value: null });
  });

  it("decodes unserializable values", () => {
    const line = JSON.stringify({
      proto_step: "initial_state",
      action: "Init",
      state: { u: { "#unserializable": "Int" } },
    });
    const msg = decodeMirrorMessage(line) as any;
    expect(msg.state.u).toEqual({ tag: "unserializable", val: "Int" });
  });

  it("encodes unserializable values", () => {
    const state: State = {
      u: { tag: "unserializable", val: "Nat" },
    };
    const encoded = encodeState(state);
    expect(encoded.u).toEqual({ "#unserializable": "Nat" });
  });
});

describe("validate + async job messages (golden wire shapes)", () => {
  const cfg: ApalacheConfig = { specPath: "s.tla", invariant: "Inv", lengthBound: 3 };

  it("encodes register_validate", () => {
    const msg: ClientMessage = {
      proto_step: "register_validate",
      apalacheConfig: cfg,
      bound: 5,
    };
    expect(JSON.parse(encodeClientMessage(msg))).toEqual({
      proto_step: "register_validate",
      apalacheConfig: { specPath: "s.tla", invariant: "Inv", lengthBound: 3 },
      bound: 5,
    });
  });

  it("encodes register_validate_async", () => {
    const msg: ClientMessage = {
      proto_step: "register_validate_async",
      apalacheConfig: cfg,
      bound: 5,
    };
    expect(JSON.parse(encodeClientMessage(msg))).toEqual({
      proto_step: "register_validate_async",
      apalacheConfig: { specPath: "s.tla", invariant: "Inv", lengthBound: 3 },
      bound: 5,
    });
  });

  it("encodes register_trace_gen_async with explicit null destPath", () => {
    const msg: ClientMessage = {
      proto_step: "register_trace_gen_async",
      apalacheConfig: cfg,
      traceConfig: { numTraces: 2 },
      destPath: null,
    };
    expect(JSON.parse(encodeClientMessage(msg))).toEqual({
      proto_step: "register_trace_gen_async",
      apalacheConfig: { specPath: "s.tla", invariant: "Inv", lengthBound: 3 },
      traceConfig: { numTraces: 2 },
      destPath: null,
    });
  });

  it("omits destPath and spec when undefined (absent ≡ null)", () => {
    const msg: ClientMessage = {
      proto_step: "register_trace_gen_async",
      apalacheConfig: cfg,
      traceConfig: { numTraces: 2 },
    };
    const parsed = JSON.parse(encodeClientMessage(msg));
    expect("destPath" in parsed).toBe(false);
    expect("spec" in parsed).toBe(false);
  });

  it("encodes query_job / await_job / cancel_job", () => {
    expect(
      JSON.parse(encodeClientMessage({ proto_step: "query_job", jobId: "job-7f3a" })),
    ).toEqual({ proto_step: "query_job", jobId: "job-7f3a" });
    expect(
      JSON.parse(encodeClientMessage({ proto_step: "await_job", jobId: "job-7f3a" })),
    ).toEqual({ proto_step: "await_job", jobId: "job-7f3a" });
    expect(
      JSON.parse(
        encodeClientMessage({ proto_step: "await_job", jobId: "job-7f3a", timeoutSecs: 30 }),
      ),
    ).toEqual({ proto_step: "await_job", jobId: "job-7f3a", timeoutSecs: 30 });
    expect(
      JSON.parse(encodeClientMessage({ proto_step: "cancel_job", jobId: "job-7f3a" })),
    ).toEqual({ proto_step: "cancel_job", jobId: "job-7f3a" });
  });

  it("decodes job_accepted (both kinds)", () => {
    expect(
      decodeMirrorMessage('{"jobId":"job-7f3a","kind":"validate","proto_step":"job_accepted"}'),
    ).toEqual({ proto_step: "job_accepted", jobId: "job-7f3a", kind: "validate" });
    expect(
      decodeMirrorMessage('{"jobId":"job-9","kind":"gen_traces","proto_step":"job_accepted"}'),
    ).toEqual({ proto_step: "job_accepted", jobId: "job-9", kind: "gen_traces" });
  });

  it("decodes job_status across all six phases", () => {
    for (const phase of ["pending", "running", "done", "failed", "cancelled", "unknown"] as const) {
      expect(
        decodeMirrorMessage(
          JSON.stringify({ proto_step: "job_status", jobId: "job-7f3a", phase }),
        ),
      ).toEqual({ proto_step: "job_status", jobId: "job-7f3a", phase });
    }
  });

  it("decodes all three job_result outcome variants", () => {
    expect(
      decodeMirrorMessage('{"jobId":"job-7f3a","outcome":{"validate":"valid"},"proto_step":"job_result"}'),
    ).toEqual({ proto_step: "job_result", jobId: "job-7f3a", outcome: { validate: "valid" } });
    expect(
      decodeMirrorMessage(
        '{"jobId":"job-9","outcome":{"genTraces":{"itfTracePaths":["out/itf/t1.itf.json"],"itfTraces":[]}},"proto_step":"job_result"}',
      ),
    ).toEqual({
      proto_step: "job_result",
      jobId: "job-9",
      outcome: { genTraces: { itfTracePaths: ["out/itf/t1.itf.json"], itfTraces: [] } },
    });
    expect(
      decodeMirrorMessage('{"jobId":"job-9","outcome":{"error":"worker died"},"proto_step":"job_result"}'),
    ).toEqual({ proto_step: "job_result", jobId: "job-9", outcome: { error: "worker died" } });
  });

  it("decodes an invalid-validate job outcome", () => {
    expect(
      decodeMirrorMessage(
        JSON.stringify({
          proto_step: "job_result",
          jobId: "job-1",
          outcome: { validate: { invalid: "Invariant violated" } },
        }),
      ),
    ).toEqual({
      proto_step: "job_result",
      jobId: "job-1",
      outcome: { validate: { invalid: "Invariant violated" } },
    });
  });
});
