import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run the same emitted executable as the tutorial scripts. Resolving relative
// to this module also permits interop to compile into its own scratch tree.
const executable = fileURLToPath(new URL("../examples/generated-counter/run.js", import.meta.url));
const ecmaRoot = resolve(process.env.MIRRORECMA_ROOT ?? process.cwd());
const mirrorsRoot = resolve(process.env.MIRRORS_ROOT ?? join(ecmaRoot, "../Mirrors"));
const mirrorBinary = resolve(process.env.MIRROR_BIN ?? join(mirrorsRoot, ".lake/build/bin/mirror"));
const compiler = resolve(process.env.MODEL_INTERFACE_GEN ?? join(mirrorsRoot, ".lake/build/bin/model_interface_gen"));
const model = join(ecmaRoot, "examples/generated-counter/specs/Counter.tla");
const fixture = join(ecmaRoot, "test/fixtures/model-interface/counter");
const environment = {
  ...process.env,
  MIRRORECMA_ROOT: ecmaRoot,
  MIRRORS_ROOT: mirrorsRoot,
  MIRROR_BIN: mirrorBinary,
};

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  label: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    // Kill the complete runner/mirror/tool group if a regression hangs a case.
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: ecmaRoot,
      env,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The process may already have exited before its close event arrives.
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label}: cannot start ${command}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code === null) {
        reject(new Error(`${label}: ${timedOut ? "timed out" : `terminated by ${signal}`}\n${stdout}${stderr}`));
        return;
      }
      resolveResult({ code, stdout, stderr });
    });
  });
}

function diagnostic(result: CommandResult): string {
  return `exit ${result.code}\n${result.stdout}${result.stderr}`;
}

function requireSuccess(label: string, result: CommandResult): void {
  assert.equal(result.code, 0, `${label}: ${diagnostic(result)}`);
}

function checkArgs(directory: string): string[] {
  return [
    "check",
    "--spec", model,
    "--contract", join(directory, "Counter.mirror-interface.json"),
    "--evidence", join(directory, "counter.itf.json"),
    "--param-var", "parameters",
    "--lock", join(directory, "Counter.mirror-interface.lock.json"),
    "--target", "mirrorecma-v1",
    "--out", join(directory, "generated"),
  ];
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        assert(entry.isFile(), `unexpected non-file in fixture: ${path}`);
        files[path] = createHash("sha256").update(await readFile(join(directory, path))).digest("hex");
      }
    }
  }
  await visit("");
  return files;
}

function requireCoverage(label: string, result: CommandResult): void {
  requireSuccess(label, result);
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith("Action coverage: "));
  assert(line, `${label}: missing action coverage\n${diagnostic(result)}`);
  const coverage: unknown = JSON.parse(line.slice("Action coverage: ".length));
  assert(coverage !== null && typeof coverage === "object" && !Array.isArray(coverage), `${label}: invalid coverage`);
  for (const action of ["Initialize", "Tick"]) {
    const count = (coverage as Record<string, unknown>)[action];
    assert(typeof count === "number" && Number.isSafeInteger(count) && count > 0,
      `${label}: ${action} was not exercised\n${diagnostic(result)}`);
  }
  console.log(`${label}: ${line}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === "--live"),
    "Usage: pnpm run smoke:generated-counter [--live]");
  const live = args[0] === "--live";
  for (const [label, path] of [["Mirrors binary", mirrorBinary], ["model-interface compiler", compiler]] as const) {
    try {
      await access(path, constants.X_OK);
    } catch {
      throw new Error(`${label} is missing or not executable: ${path}; run lake build mirror model_interface_gen in MIRRORS_ROOT`);
    }
  }
  try {
    await access(executable);
  } catch {
    throw new Error(`Tutorial executable is missing: ${executable}; run pnpm run build:examples`);
  }

  assert.deepEqual(await readFile(model), await readFile(join(mirrorsRoot, "specs/Counter.tla")),
    "Tutorial Counter.tla differs from the authoritative Mirrors model");
  console.log("Tutorial model matches Mirrors/specs/Counter.tla.");

  const original = await snapshot(fixture);
  const scratch = await mkdtemp(join(tmpdir(), "mirrorecma-generated-counter-"));
  const offlineEnvironment = { ...environment, APALACHE_MC: join(scratch, "apalache-unavailable") };
  try {
    const clean = await run("compiler check", compiler, checkArgs(fixture), offlineEnvironment);
    requireSuccess("compiler check", clean);
    assert.match(clean.stdout, /model-interface check clean/);
    const preflight = await run("required-action preflight", compiler, [
      "preflight",
      "--lock", join(fixture, "Counter.mirror-interface.lock.json"),
      "--trace", join(fixture, "counter.itf.json"),
      "--require-all-actions",
    ], offlineEnvironment);
    requireSuccess("required-action preflight", preflight);
    console.log("Compiler check and required-action preflight passed.");

    const copiedFixture = join(scratch, "counter");
    await cp(fixture, copiedFixture, { recursive: true });
    await appendFile(join(copiedFixture, "generated/CounterMirror.generated.ts"), "\n// Deliberately stale acceptance fixture.\n");
    const staleSnapshot = await snapshot(copiedFixture);
    const stale = await run("stale generated output", compiler, checkArgs(copiedFixture), offlineEnvironment);
    assert.equal(stale.code, 1, `stale output must fail check: ${diagnostic(stale)}`);
    assert.match(`${stale.stdout}${stale.stderr}`, /^stale: .*CounterMirror\.generated\.ts$/m,
      `check must identify the changed generated file: ${diagnostic(stale)}`);
    assert.deepEqual(await snapshot(copiedFixture), staleSnapshot, "compiler check repaired or changed the stale fixture");
    console.log("Stale generated output was detected without repair.");

    const replay = await run("offline Counter replay", process.execPath, [executable], offlineEnvironment);
    requireCoverage("Offline replay with Apalache unavailable", replay);
    assert.match(replay.stdout, /^Counter replay passed\.$/m);

    const broken = await run("faulty Counter replay", process.execPath, [executable, "--broken"], offlineEnvironment);
    assert.equal(broken.code, 1, `faulty Counter must exit 1: ${diagnostic(broken)}`);
    assert.match(broken.stderr, /step mismatch/i,
      `faulty Counter must fail on observed state, not infrastructure: ${diagnostic(broken)}`);
    assert.match(broken.stderr, /\btick\b/i, diagnostic(broken));
    assert.match(broken.stderr, /\bcount\b/i, diagnostic(broken));
    assert.doesNotMatch(broken.stdout, /Counter .* passed\.|Action coverage:/, diagnostic(broken));
    console.log(`Faulty Counter produced the expected failure: ${broken.stderr.trim()}`);

    if (live) {
      console.log("Running live Counter generation with Apalache.");
      const result = await run("live Counter generation", process.execPath, [executable, "--live"], environment, 300_000);
      requireCoverage("Live generation", result);
      assert.match(result.stdout, /^Counter live run passed\.$/m);
    } else {
      console.log("Live generation not requested; use --live with APALACHE_MC to include it.");
    }
    assert.deepEqual(await snapshot(fixture), original, "tutorial acceptance changed the shared fixture");
    console.log("Generated Counter tutorial acceptance passed.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`Generated Counter acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
