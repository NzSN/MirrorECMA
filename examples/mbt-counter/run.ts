import { resolve } from "node:path";
import { ReplayMismatchError } from "../../src/index.js";
import { createLocalCounterFactory } from "./local-provider.js";
import { counterReplayInputs, runCounterSuite } from "./suite.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--broken")) {
    throw new Error("Usage: run.js [--broken]");
  }
  const mirror = process.env.MIRROR_BIN;
  if (!mirror) throw new Error("Set MIRROR_BIN to an executable Mirrors binary.");
  const report = await runCounterSuite({
    mirror: resolve(mirror), ...counterReplayInputs(process.cwd()),
  }, createLocalCounterFactory(args[0] === "--broken"));
  console.log(JSON.stringify(report));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify(error instanceof ReplayMismatchError
    ? error.toJSON()
    : { message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
