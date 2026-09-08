import { evaluateSandboxed, type SandboxWorkerRuntime } from "../../src/index.js";
import { SandboxCounterModel } from "./model.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const runtime = (process.env["MIRRORGATE_WORKER_RUNTIME"] ?? "node-v1") as SandboxWorkerRuntime;
  const result = await evaluateSandboxed({
    gate: {
      kind: "owned",
      launcher: { command: required("MIRRORGATE_BIN") },
      policyFile: required("MIRRORGATE_POLICY_FILE"),
    },
    policyId: required("MIRRORGATE_POLICY_ID"),
    submission: {
      kind: "prebuilt",
      input: {
        rootId: required("MIRRORGATE_INPUT_ROOT_ID"),
        relativePath: required("MIRRORGATE_SUBMISSION_PATH"),
      },
    },
    runtime,
    model: SandboxCounterModel,
    replay: {
      kind: "traces",
      target: required("MIRROR_BIN"),
      config: {
        specPath: required("MIRROR_SPEC_PATH"),
        invariant: required("MIRROR_INVARIANT"),
        constInit: process.env["MIRROR_CONST_INIT"] ?? "CInit",
        lengthBound: Number(process.env["MIRROR_LENGTH_BOUND"] ?? "2"),
        paramVars: "parameters",
      },
      tracePaths: [required("MIRROR_TRACE_PATH")],
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "sandbox example failed"}\n`);
  process.exitCode = 1;
});
