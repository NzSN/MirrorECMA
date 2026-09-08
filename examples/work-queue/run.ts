import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import {
  replayReportFromError,
  runClientNegotiatedWithReport,
  runClientWithTracesNegotiatedWithReport,
  specFromFiles,
  type ApalacheConfig,
} from "../../src/index.js";
import { assertQueueCoverage, createQueueSelection } from "./adapter.js";
import { BrokenWorkQueue, WorkQueue } from "./queue.js";

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch { return false; }
}

async function requireApalache(): Promise<void> {
  const command = process.env.APALACHE_MC ?? "apalache-mc";
  const candidates = command.includes("/") || command.includes("\\")
    ? [resolve(command)]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    if (command.length > 0 && await executable(candidate)) {
      process.env.APALACHE_MC = candidate;
      return;
    }
  }
  throw new Error(`Live queue generation requires Apalache; set APALACHE_MC to its executable (tried ${JSON.stringify(command)}).`);
}

async function main(): Promise<void> {
  const flags = new Set<string>();
  for (const flag of process.argv.slice(2)) {
    if ((flag !== "--live" && flag !== "--broken") || flags.has(flag)) {
      throw new Error(`Invalid argument ${JSON.stringify(flag)}. Usage: run.js [--live] [--broken]`);
    }
    flags.add(flag);
  }
  const mirrorsRoot = resolve(process.env.MIRRORS_ROOT ?? "../Mirrors");
  const mirrorBinary = resolve(process.env.MIRROR_BIN ?? resolve(mirrorsRoot, ".lake/build/bin/mirror"));
  if (!await executable(mirrorBinary)) {
    throw new Error(`Mirrors executable unavailable: ${mirrorBinary}. Build mirror and model_interface_gen in MIRRORS_ROOT first.`);
  }
  const model = resolve("examples/work-queue/specs/WorkQueue.tla");
  const trace = resolve("examples/work-queue/artifacts/witness.itf.json");
  await access(model, constants.R_OK);
  const live = flags.has("--live");
  if (live) await requireApalache();
  else await access(trace, constants.R_OK);
  const config: ApalacheConfig = {
    specPath: model,
    initPredicate: "Init",
    nextPredicate: "WitnessNext",
    invariant: "TraceComplete",
    lengthBound: 15,
    paramVars: "parameters",
  };
  const selection = createQueueSelection(() => flags.has("--broken")
    ? BrokenWorkQueue.create(process.env.QUEUE_STORE_PARENT)
    : WorkQueue.create(process.env.QUEUE_STORE_PARENT));
  const options = { actionTimeoutMs: 10_000, receiveTimeoutMs: live ? 180_000 : 30_000 };
  // Replay twice in one session: Initialize must clear the previous trace's store.
  const report = live
    ? await runClientNegotiatedWithReport(mirrorBinary, config, { numTraces: 1, view: "View" }, selection,
      { ...options, spec: await specFromFiles(model) })
    : await runClientWithTracesNegotiatedWithReport(mirrorBinary, config, [trace, trace], selection, options);
  assertQueueCoverage(report);
  console.log(live ? "Work queue live run passed." : "Work queue replay passed.");
  console.log(`Replay report: ${JSON.stringify(report)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  const report = replayReportFromError(error);
  if (report) console.error(`Replay report: ${JSON.stringify(report)}`);
  process.exitCode = 1;
});
