import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeMirrorMessage,
  encodeClientMessage,
  type ClientMessage,
} from "../src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = process.env.MIRRORS_FIXTURES ?? resolve(here, "../../Mirrors/test/fixtures");

async function jsonLines(name: string): Promise<unknown[]> {
  const text = await readFile(resolve(fixtures, name), "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("canonical Mirrors wire corpus", () => {
  it("re-encodes every canonical client transcript semantically", async () => {
    for (const expected of await jsonLines("client_messages.jsonl")) {
      const encoded = JSON.parse(encodeClientMessage(expected as ClientMessage));
      expect(encoded).toEqual(expected);
    }
  });

  it("decodes every canonical mirror transcript to its proto_step", async () => {
    for (const expected of await jsonLines("mirror_messages.jsonl")) {
      const raw = expected as { proto_step: string };
      const decoded = decodeMirrorMessage(JSON.stringify(raw));
      expect(decoded.proto_step).toBe(raw.proto_step);
    }
  });
});
