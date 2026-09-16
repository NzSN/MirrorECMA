import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { runQueueAcceptance } from "./acceptance.js";

function main(): void {
  const args = process.argv.slice(2);
  let json = false, receiptPath: string | undefined, tracePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json" && !json) json = true;
    else if (args[i] === "--receipt" && !receiptPath && args[i + 1]) receiptPath = args[++i];
    else if (args[i] === "--trace" && !tracePath && args[i + 1]) tracePath = resolve(args[++i]!);
    else throw new Error("Usage: acceptance-cli.js [--json] [--receipt NEW_FILE] [--trace ITF_FILE]");
  }
  const root = resolve(process.env.MIRRORECMA_ROOT ?? process.cwd());
  runQueueAcceptance({
    root,
    mirrorBinary: process.env.MIRROR_BIN ? resolve(process.env.MIRROR_BIN) : undefined,
    receiveTimeoutMs: 60_000,
    tracePath,
  }).then(async ({ scenarios, correctReport, receipt }) => {
    const failed = scenarios.filter((scenario) => !scenario.accepted);
    if (receiptPath) await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (json) {
      console.log(JSON.stringify(receipt, null, 2));
    } else {
      console.log(`correct implementation: ${correctReport.status} (${correctReport.statesMatched} states, ${correctReport.stepsCompleted} steps)`);
      for (const scenario of scenarios) {
        const failure = scenario.firstMismatch;
        const detail = failure === null ? "not rejected" : `trace ${failure.traceIndex} state ${failure.stateIndex} action ${failure.action} (${failure.code})`;
        console.log(`${scenario.accepted ? "rejected" : "MISSED  "} ${scenario.fault}: ${detail}`);
      }
      console.log(`cleanup: ${receipt.cleanup.remainingEntries.length === 0 ? "clean" : `${receipt.cleanup.remainingEntries.length} entries remain`}`);
    }
    if (failed.length > 0) process.exitCode = 1;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

main();
