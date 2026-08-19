import { createHash } from "node:crypto";
import { normalizeFingerprint, sha256Hex } from "../src/transport.js";

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