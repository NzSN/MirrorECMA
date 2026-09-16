import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let json = false, receiptPath: string | undefined, tracePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json" && !json) json = true;
    else if (args[i] === "--receipt" && !receiptPath && args[i + 1]) receiptPath = args[++i];
    else if (args[i] === "--trace" && !tracePath && args[i + 1]) tracePath = resolve(args[++i]!);
    else throw new Error("Usage: acceptance-cli.js [--json] [--receipt NEW_FILE] [--trace ITF_FILE]");
  }
  const root = resolve(process.env.MIRRORECMA_ROOT ?? process.cwd());
  const runnerUrl = pathToFileURL(resolve(root, "examples/application-validation/suite.mjs"));
  const { loadApplication, runLocalAcceptance } = await import(runnerUrl.href);
  const app = await loadApplication("work-queue");
  const receipt = await runLocalAcceptance(app, {
    ...(process.env.MIRROR_BIN ? { mirror: resolve(process.env.MIRROR_BIN) } : {}),
    ...(tracePath ? { tracePaths: [tracePath, tracePath] } : {}),
  });
  if (receiptPath) await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (json) console.log(JSON.stringify(receipt, null, 2));
  else {
    for (const result of receipt.results) {
      const failure = result.failure;
      const detail = failure?.code === "replay_mismatch"
        ? `trace ${failure.traceIndex} state ${failure.stateIndex} action ${failure.action}`
        : `${result.suiteResult.evidence.transitionsMatched} matched transitions`;
      console.log(`${result.variant}: ${result.classification}; ${detail}; cleanup ${result.cleanup.status}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
