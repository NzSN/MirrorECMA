import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  MAX_PROTOCOL_LINE_BYTES,
  normalizeFingerprint,
  protocolLineIterator,
  sha256Hex,
  validateProtocolLine,
} from "../src/transport.js";

const HEX64 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("normalizeFingerprint", () => {
  it("passes a lowercase 64-hex fingerprint through unchanged", () => {
    expect(normalizeFingerprint(HEX64)).toBe(HEX64);
  });

  it("lowercases and trims surrounding whitespace", () => {
    const upper = HEX64.toUpperCase();
    expect(normalizeFingerprint(upper)).toBe(HEX64);
    expect(normalizeFingerprint(`  ${upper}  `)).toBe(HEX64);
  });

  it("normalizes mixed case", () => {
    const mixed = "aBcDeF0123456789".repeat(4);
    expect(normalizeFingerprint(mixed)).toBe(mixed.toLowerCase());
  });

  it("throws on fingerprints that are not 64 lowercase hex chars", () => {
    const bad = [
      ["empty", ""],
      ["short", "abc"],
      ["63 chars", "a".repeat(63)],
      ["65 chars", "a".repeat(65)],
      ["non-hex char", "g" + "0".repeat(63)],
      ["whitespace mixed in", "  " + HEX64 + " extra"],
    ];
    for (const [label, value] of bad) {
      expect(() => normalizeFingerprint(value)).toThrow(/invalid certificate fingerprint/);
      void label;
    }
  });
});

describe("sha256Hex", () => {
  it("matches node:crypto's SHA-256 over a DER-like byte fixture", () => {
    const fixture = Uint8Array.from([
      0x30, 0x82, 0x03, 0x4b, 0x30, 0x82, 0x02, 0x33, 0xa0, 0x03, 0x02, 0x01,
      0x02, 0x02, 0x09, 0x00, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
      0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
      0x0b, 0x05, 0x00, 0x30, 0x1f, 0x31, 0x1d, 0x30, 0x1b, 0x06, 0x03, 0x55,
      0x04, 0x03, 0x0c, 0x14, 0x4d, 0x69, 0x72, 0x72, 0x6f, 0x72, 0x45, 0x43,
      0x4d, 0x41, 0x20, 0x54, 0x65, 0x73, 0x74, 0x20, 0x43, 0x41, 0x01, 0x02,
    ]);
    const expected = createHash("sha256").update(fixture).digest("hex");
    expect(sha256Hex(fixture)).toBe(expected);
  });

  it("digests arbitrary bytes (including NUL and 0xFF) without string coercion", () => {
    const fixture = Uint8Array.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80, 0x00, 0x0a]);
    // A string-typed digest of the same input would hash "[0,1,255,...]"'s chars;
    // byte-integrity is caught by comparing against node:crypto over the bytes.
    const expected = createHash("sha256").update(fixture).digest("hex");
    expect(sha256Hex(fixture)).toBe(expected);
  });

  it("matches the known SHA-256 of the empty input (golden value)", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("protocol line validation", () => {
  it("accepts the largest framed payload and measures UTF-8 bytes", () => {
    expect(() => validateProtocolLine("a".repeat(MAX_PROTOCOL_LINE_BYTES))).not.toThrow();
    expect(() => validateProtocolLine("é".repeat(Math.floor(MAX_PROTOCOL_LINE_BYTES / 2)))).not.toThrow();
  });

  it("rejects empty, embedded-newline, and oversized payloads", () => {
    expect(() => validateProtocolLine("")).toThrow(/must not be empty/);
    expect(() => validateProtocolLine("{}\n{}" )).toThrow(/embedded newline/);
    expect(() => validateProtocolLine("a".repeat(MAX_PROTOCOL_LINE_BYTES + 1))).toThrow(/maximum/);
    expect(() => validateProtocolLine("é".repeat(Math.floor(MAX_PROTOCOL_LINE_BYTES / 2) + 1))).toThrow(/maximum/);
  });
});

describe("inbound protocol framing", () => {
  function framedStream() {
    const input = new PassThrough();
    let closeCalls = 0;
    const close = async () => { closeCalls += 1; return 0; };
    const iterator = protocolLineIterator(input, close);
    return { input, closeCalls: () => closeCalls, iterator };
  }

  it("accepts exactly 65,535 payload bytes before LF", async () => {
    const { input, closeCalls, iterator } = framedStream();
    const payload = "a".repeat(MAX_PROTOCOL_LINE_BYTES);
    input.end(Buffer.from(`${payload}\n`));

    await expect(iterator.next()).resolves.toEqual({ value: payload, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: "", done: true });
    expect(closeCalls()).toBe(0);
  });

  it("rejects 65,536 payload bytes before decoding or parsing", async () => {
    const { input, closeCalls, iterator } = framedStream();
    const next = iterator.next();
    input.write(Buffer.alloc(MAX_PROTOCOL_LINE_BYTES + 1, 0x61));

    await expect(next).rejects.toThrow(/exceeds 65535 UTF-8 bytes/);
    await Promise.resolve();
    expect(closeCalls()).toBe(1);
  });

  it("counts UTF-8 bytes and preserves characters split across chunks", async () => {
    const { input, closeCalls, iterator } = framedStream();
    const payload = `${"é".repeat(32_767)}a`;
    const encoded = Buffer.from(`${payload}\n`);
    // Split between the two bytes of the first non-ASCII code point.
    input.write(encoded.subarray(0, 1));
    input.end(encoded.subarray(1));

    await expect(iterator.next()).resolves.toEqual({ value: payload, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: "", done: true });
    expect(Buffer.byteLength(payload, "utf8")).toBe(MAX_PROTOCOL_LINE_BYTES);
    expect(closeCalls()).toBe(0);
  });

  it("rejects a multibyte payload whose byte length exceeds the limit", async () => {
    const { input, closeCalls, iterator } = framedStream();
    const next = iterator.next();
    input.write(Buffer.from("é".repeat(32_768)));

    await expect(next).rejects.toThrow(/exceeds 65535 UTF-8 bytes/);
    await Promise.resolve();
    expect(closeCalls()).toBe(1);
  });

  it("uses fatal UTF-8 decoding", async () => {
    const { input, closeCalls, iterator } = framedStream();
    const next = iterator.next();
    input.end(Buffer.from([0xc3, 0x28, 0x0a]));

    await expect(next).rejects.toThrow(/not valid UTF-8/);
    await Promise.resolve();
    expect(closeCalls()).toBe(1);
  });

  it("preserves legacy delivery of a final unterminated line at EOF", async () => {
    const { input, closeCalls, iterator } = framedStream();
    input.end(Buffer.from("{\"proto_step\":\"all_steps_done\"}"));

    await expect(iterator.next()).resolves.toEqual({
      value: "{\"proto_step\":\"all_steps_done\"}",
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({ value: "", done: true });
    expect(closeCalls()).toBe(0);
  });

  it("normalizes CRLF without charging the CR against the payload bound", async () => {
    const { input, iterator } = framedStream();
    const payload = "a".repeat(MAX_PROTOCOL_LINE_BYTES);
    input.end(Buffer.from(`${payload}\r\n`));

    await expect(iterator.next()).resolves.toEqual({ value: payload, done: false });
  });

  it("delivers no records when a later record in the same chunk is oversized", async () => {
    const { input, closeCalls, iterator } = framedStream();
    const matched = "{\"proto_step\":\"spec_validated\",\"result\":\"valid\"}";
    const initial = "{\"proto_step\":\"initial_state\",\"action\":\"Initialize\"}";
    input.write(Buffer.concat([
      Buffer.from(`${matched}\n${initial}\n`),
      Buffer.alloc(MAX_PROTOCOL_LINE_BYTES + 1, 0x61),
      Buffer.from("\n"),
    ]));

    await expect(iterator.next()).rejects.toThrow(/protocol framing error/);
    await expect(iterator.next()).rejects.toThrow(/protocol framing error/);
    await Promise.resolve();
    expect(closeCalls()).toBe(1);
  });

  it("discards previously buffered records when framing later fails", async () => {
    const { input, closeCalls, iterator } = framedStream();
    input.write(Buffer.from("{\"proto_step\":\"spec_validated\"}\n"));
    input.write(Buffer.alloc(MAX_PROTOCOL_LINE_BYTES + 1, 0x61));

    await expect(iterator.next()).rejects.toThrow(/protocol framing error/);
    await Promise.resolve();
    expect(closeCalls()).toBe(1);
  });

  it("preserves valid sequential records received in separate chunks", async () => {
    const { input, closeCalls, iterator } = framedStream();
    const matched = "{\"proto_step\":\"spec_validated\",\"result\":\"valid\"}";
    const initial = "{\"proto_step\":\"initial_state\",\"action\":\"Initialize\"}";

    input.write(Buffer.from(`${matched}\n`));
    await expect(iterator.next()).resolves.toEqual({ value: matched, done: false });
    input.write(Buffer.from(`${initial}\n`));
    await expect(iterator.next()).resolves.toEqual({ value: initial, done: false });

    const failed = iterator.next();
    input.write(Buffer.alloc(MAX_PROTOCOL_LINE_BYTES + 1, 0x61));
    await expect(failed).rejects.toThrow(/protocol framing error/);
    await Promise.resolve();
    expect(closeCalls()).toBe(1);
  });

  it.each(["stdio", "TCP", "TLS"])(
    "closes exactly once after a fatal %s framing error",
    async () => {
      // All three production constructors delegate to protocolLineIterator;
      // use an in-memory byte stream to keep this boundary test deterministic.
      const { input, closeCalls, iterator } = framedStream();
      const next = iterator.next();
      input.write(Buffer.alloc(MAX_PROTOCOL_LINE_BYTES + 1, 0x61));
      input.write(Buffer.from("more attacker data\n"));
      input.end();

      await expect(next).rejects.toThrow(/protocol framing error/);
      await Promise.resolve();
      expect(closeCalls()).toBe(1);
    },
  );
});
