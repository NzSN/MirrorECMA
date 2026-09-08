import {
  decodeMirrorMessage,
  encodeState,
  type State,
  type Value,
} from "../src/protocol.js";
import { OpaqueItfValue, opaqueItfValue } from "../src/opaque-itf.js";

const labels = ["__proto__", "constructor", "prototype"] as const;
const fields = Object.fromEntries(labels.map((label) => [label, {
  tag: "record",
  val: { payload: { tag: "int", val: 9007199254740993123456789n } },
}])) as State;
const record: Value = { tag: "record", val: fields };
const complex: Value = {
  tag: "record",
  val: {
    ...fields,
    set: { tag: "set", val: [record] },
    seq: { tag: "seq", val: [record] },
    tuple: { tag: "tuple", val: [record] },
    map: { tag: "map", val: [[record, record]] },
    variant: { tag: "variant", variantTag: "Payload", value: record },
  },
};

/** Every codec-created object retains its ordinary prototype and own fields. */
function assertPlainObjects(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const child of value) assertPlainObjects(child);
    return;
  }
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  for (const key of Object.keys(value)) {
    expect(Object.getOwnPropertyDescriptor(value, key)).toMatchObject({
      enumerable: true, configurable: true, writable: true,
    });
  }
  for (const child of Object.values(value)) assertPlainObjects(child);
}

describe("opaque protocol wire labels", () => {
  it.each(labels)("preserves %s as a state key and nested opaque record field", (label) => {
    const objectPrototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
    const wrapped = opaqueItfValue(complex);
    const state: State = Object.fromEntries([[label, OpaqueItfValue.encode(wrapped)]]);
    const encoded = encodeState(state);
    const wire = JSON.stringify({ proto_step: "initial_state", action: "init", state: encoded });
    const message = decodeMirrorMessage(wire);

    expect(Object.hasOwn(encoded, label)).toBe(true);
    expect(wire).toContain('"__proto__":');
    expect(wire).toContain('"constructor":');
    expect(wire).toContain('"prototype":');
    expect(message.proto_step).toBe("initial_state");
    if (message.proto_step !== "initial_state") throw new Error("expected initial state");
    expect(Object.hasOwn(message.state, label)).toBe(true);
    expect(message.state).toEqual(state);
    expect(opaqueItfValue(message.state[label]!).value).toEqual(wrapped.value);
    expect(JSON.stringify(encodeState(message.state))).toBe(JSON.stringify(encoded));
    assertPlainObjects(encoded);
    assertPlainObjects(message.state);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(objectPrototypeBefore);
  });

  it("decodes and re-encodes a literal __proto__ field without invoking its inherited setter", () => {
    const wireState = '{"__proto__":{"payload":{"#bigint":"7"}},"constructor":true,"prototype":"data"}';
    const message = decodeMirrorMessage(`{"proto_step":"explore_state","state":${wireState}}`);
    if (message.proto_step !== "explore_state") throw new Error("expected explorer state");
    expect(Object.getPrototypeOf(message.state)).toBe(Object.prototype);
    expect(Object.hasOwn(message.state, "__proto__")).toBe(true);
    expect(message.state["__proto__"]).toEqual({
      tag: "record", val: { payload: { tag: "int", val: 7n } },
    });
    expect(JSON.stringify(encodeState(message.state))).toBe(wireState);
  });
});
