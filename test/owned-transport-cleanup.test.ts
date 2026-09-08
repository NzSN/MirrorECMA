import { resolve } from "node:path";
import { jest } from "@jest/globals";
import { spawnMirror } from "../src/transport.js";

describe("owned Mirrors transport cleanup", () => {
  jest.setTimeout(10_000);

  it("bounds cleanup when the child ignores stdin EOF and SIGTERM", async () => {
    const transport = spawnMirror(resolve("test/fixtures/ignore-sigterm-mirror.mjs"));
    const started = performance.now();
    await expect(transport.close()).resolves.toBe(0);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(3_500);
    expect(elapsed).toBeLessThan(6_500);
    await expect(transport.close()).resolves.toBe(0);
  });
});
