import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertQueueCoverage, createQueueSelection } from "../examples/work-queue/adapter.js";
import { WorkQueue } from "../examples/work-queue/queue.js";
import { runClientWithTracesNegotiatedWithReport, type ReplayReport } from "../src/index.js";

const root = resolve(process.env.MIRRORECMA_ROOT ?? process.cwd());
const mirrorsRoot = resolve(process.env.MIRRORS_ROOT ?? join(root, "../Mirrors"));
const mirror = resolve(process.env.MIRROR_BIN ?? join(mirrorsRoot, ".lake/build/bin/mirror"));
const compiler = resolve(process.env.MODEL_INTERFACE_GEN ?? join(mirrorsRoot, ".lake/build/bin/model_interface_gen"));
const model = join(root, "examples/work-queue/specs/WorkQueue.tla");
const artifacts = join(root, "examples/work-queue/artifacts");
const trace = join(artifacts, "witness.itf.json");
const executable = fileURLToPath(new URL("../examples/work-queue/run.js", import.meta.url));

interface Result { code: number; stdout: string; stderr: string }

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<Result> {
  return new Promise((resolveResult, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd: root, env, detached, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The process may already have exited. */ }
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code === null) {
        reject(new Error(`${command} ${timedOut ? "timed out" : `terminated by ${signal}`}\n${stdout}${stderr}`));
      } else resolveResult({ code, stdout, stderr });
    });
  });
}

function output(result: Result): string { return `exit ${result.code}\n${result.stdout}${result.stderr}`; }
function success(result: Result): void { assert.equal(result.code, 0, output(result)); }

function report(result: Result): ReplayReport {
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find((item) => item.startsWith("Replay report: "));
  assert(line, `missing JSON report: ${output(result)}`);
  const parsed: ReplayReport = JSON.parse(line.slice("Replay report: ".length));
  assert.equal(parsed.schema, "mirrorecma.replay-report/v1");
  return parsed;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, item.name);
      if (item.isDirectory()) await visit(path);
      else entries[path] = await digest(join(directory, path));
    }
  }
  await visit("");
  return entries;
}

function checkArgs(directory: string): string[] {
  return ["check", "--spec", model,
    "--contract", join(directory, "WorkQueue.mirror-interface.json"),
    "--evidence", join(directory, "witness.itf.json"), "--param-var", "parameters",
    "--lock", join(directory, "WorkQueue.mirror-interface.lock.json"),
    "--target", "mirrorecma-v1", "--out", join(directory, "generated")];
}

function passingReport(result: Result, expectedTraces?: number): void {
  success(result);
  const value = report(result);
  assert.equal(value.status, "passed");
  assertQueueCoverage(value);
  assert(value.tracesCompleted > 0);
  if (expectedTraces !== undefined) assert.equal(value.tracesCompleted, expectedTraces);
  assert.equal(value.statesMatched, value.tracesCompleted * 16);
  assert.equal(value.stepsCompleted, value.tracesCompleted * 15);
  assert.equal(value.actionCounts.init, value.tracesCompleted);
  assert.equal(value.actionCounts.reset, value.tracesCompleted);
  assert(!value.sequenceCounts.some((pair) => pair.from === "complete" && pair.to === "init"),
    "pair coverage must not join independent trace boundaries");
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  assert(flags.length === 0 || (flags.length === 1 && flags[0] === "--live"),
    "Usage: pnpm run smoke:work-queue [--live]");
  const original = await snapshot(artifacts);
  const provenance = JSON.parse(await readFile(join(artifacts, "provenance.json"), "utf8"));
  assert.equal(provenance.generator, "Apalache");
  assert.equal(provenance.modelSha256, await digest(model), "model changed without regenerating its witness");
  assert.equal(provenance.traceSha256, await digest(trace), "trace changed without regenerating provenance");
  const witness = JSON.parse(await readFile(trace, "utf8"));
  assert.equal(witness.states.length, 16);
  assert.equal(witness["#meta"].varTypes.pending, "Seq(Int)");
  assert.match(witness["#meta"].description, /Created by Apalache/);
  const scratch = await mkdtemp(join(tmpdir(), "mirrorecma-queue-smoke-"));
  const stores = join(scratch, "stores");
  await mkdir(stores);
  const env = { ...process.env, MIRRORS_ROOT: mirrorsRoot, MIRROR_BIN: mirror, QUEUE_STORE_PARENT: stores };
  const offline = { ...env, APALACHE_MC: join(scratch, "apalache-unavailable") };
  try {
    success(await run(compiler, checkArgs(artifacts), offline));
    success(await run(compiler, ["preflight", "--lock", join(artifacts, "WorkQueue.mirror-interface.lock.json"),
      "--trace", trace, "--require-all-actions"], offline));
    const stale = join(scratch, "stale");
    await cp(artifacts, stale, { recursive: true });
    await appendFile(join(stale, "generated/WorkQueueMirror.generated.ts"), "\n// stale acceptance fixture\n");
    const beforeStale = await snapshot(stale);
    const staleResult = await run(compiler, checkArgs(stale), offline);
    assert.equal(staleResult.code, 1, output(staleResult));
    assert.match(`${staleResult.stdout}${staleResult.stderr}`, /stale: .*WorkQueueMirror\.generated\.ts/);
    assert.deepEqual(await snapshot(stale), beforeStale, "check must not repair generated files");
    console.log("Queue provenance, compiler freshness, required-action preflight, and stale-output rejection passed.");

    const replay = await run(process.execPath, [executable], offline);
    passingReport(replay, 2);
    assert.deepEqual(await readdir(stores), [], "successful replay leaked its temporary store");
    console.log("Offline queue replay passed: FIFO, all duplicate phases, fail/retry, reset, and trace initialization.");

    const broken = await run(process.execPath, [executable, "--broken"], offline);
    assert.equal(broken.code, 1, output(broken));
    const failure = report(broken).failure;
    assert.equal(failure?.code, "step_mismatch", output(broken));
    assert.equal(failure.action, "enqueue");
    assert.equal(failure.traceIndex, 1);
    assert.equal(failure.stateIndex, 2);
    assert.deepEqual(failure.expected?.pending, [{ "#bigint": "1" }]);
    assert.deepEqual(failure.actual?.pending, [{ "#bigint": "1" }, { "#bigint": "1" }]);
    assert.deepEqual(await readdir(stores), [], "mismatched replay leaked its temporary store");
    console.log("Faulty queue failed at duplicate enqueue with expected [1], actual [1, 1]; cleanup passed.");

    let factories = 0;
    const selection = createQueueSelection(async () => {
      factories += 1;
      return WorkQueue.create(stores);
    });
    await assert.rejects(runClientWithTracesNegotiatedWithReport(mirror, {
      specPath: model, invariant: "TraceComplete", lengthBound: 15, paramVars: "parameters",
    }, [trace], { ...selection, semanticDigest: "0".repeat(64) }, { receiveTimeoutMs: 10_000 }), /digest/i);
    assert.equal(factories, 0, "rejected negotiation allocated an application store");
    assert.deepEqual(await readdir(stores), []);
    console.log("Rejected descriptor negotiation did not create application resources.");

    if (flags[0] === "--live") {
      const live = await run(process.execPath, [executable, "--live"], env, 240_000);
      passingReport(live);
      assert.deepEqual(await readdir(stores), [], "live replay leaked its temporary store");
      console.log("Live Apalache witness generation, replay, action/pair coverage, and cleanup passed.");
    } else console.log("Live generation skipped; add --live with APALACHE_MC to include it.");
    assert.deepEqual(await snapshot(artifacts), original, "acceptance modified checked artifacts");
    console.log("Work queue example acceptance passed.");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
