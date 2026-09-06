import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

import {
  runClientNegotiated,
  runClientWithTracesNegotiated,
  specFromFiles,
  type ApalacheConfig,
} from "../../src/index.js";
import { createCounterRun } from "./adapter.js";
import { BrokenCounter } from "./counter.js";

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function requireInput(path: string, description: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
    if (!(await stat(path)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(
      `${description} is missing or unreadable: ${path}. Run this command from the MirrorECMA repository root with the checked-in example and fixtures present.`,
    );
  }
}

async function requireApalache(): Promise<void> {
  const command = process.env.APALACHE_MC ?? "apalache-mc";
  const candidates = command.includes("/") || command.includes("\\")
    ? [resolve(command)]
    : (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, command));
  for (const candidate of candidates) {
    if (command.length > 0 && await isExecutable(candidate)) {
      // Mirrors changes Apalache's working directory; preserve this exact tool.
      process.env.APALACHE_MC = candidate;
      return;
    }
  }
  throw new Error(
    `Live mode requires an executable Apalache tool; could not find ${JSON.stringify(command)}. Set APALACHE_MC=/absolute/path/to/apalache-mc or add apalache-mc to PATH.`,
  );
}

async function main(): Promise<void> {
  const flags = new Set<string>();
  for (const arg of process.argv.slice(2)) {
    if ((arg !== "--live" && arg !== "--broken") || flags.has(arg)) {
      throw new Error(`Invalid argument ${JSON.stringify(arg)}. Usage: run.js [--live] [--broken]`);
    }
    flags.add(arg);
  }

  const live = flags.has("--live");
  const model = resolve("examples/generated-counter/specs/Counter.tla");
  const trace = resolve("test/fixtures/model-interface/counter/counter.itf.json");
  const mirrorsRoot = resolve(process.env.MIRRORS_ROOT ?? "../Mirrors");
  const mirrorBin = resolve(process.env.MIRROR_BIN ?? resolve(mirrorsRoot, ".lake/build/bin/mirror"));
  await requireInput(model, "Tutorial model");
  if (!live) await requireInput(trace, "Counter trace");
  if (!(await isExecutable(mirrorBin))) {
    throw new Error(
      `Mirrors executable is missing or not executable: ${mirrorBin}. Run lake build mirror model_interface_gen in the Mirrors checkout, then set MIRRORS_ROOT to that checkout or MIRROR_BIN to its mirror executable.`,
    );
  }
  if (live) await requireApalache();

  const config: ApalacheConfig = {
    specPath: model,
    invariant: "TraceComplete",
    lengthBound: 6,
    constInit: "CInit",
    paramVars: "parameters",
  };
  const run = createCounterRun(flags.has("--broken") ? () => new BrokenCounter() : undefined);
  if (live) {
    await runClientNegotiated(
      mirrorBin,
      config,
      { numTraces: 1, view: "View" },
      run.selection,
      { spec: await specFromFiles(model) },
    );
  } else {
    await runClientWithTracesNegotiated(mirrorBin, config, [trace], run.selection);
  }

  run.assertAllActionsCovered();
  console.log(live ? "Counter live run passed." : "Counter replay passed.");
  console.log(`Action coverage: ${JSON.stringify(run.coverage())}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
