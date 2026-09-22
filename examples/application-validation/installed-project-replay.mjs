/** Fixed installed-project qualification wrapper. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, outputArgument] = process.argv.slice(2);
assert(
  (mode === "correct" || mode === "faulty") &&
    outputArgument &&
    process.argv.length === 4,
  "Usage: node installed-project-replay.mjs correct|faulty OUTPUT_ROOT",
);

async function boundedJson(path, limit = 8 * 1024 * 1024) {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    assert(info.isFile() && info.size <= limit, `${path} is not a bounded file`);
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function outputRoot(path) {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  assert(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o777) === 0o700,
    "output root must be a pre-existing non-symlink mode-0700 directory",
  );
  if (typeof process.getuid === "function")
    assert.equal(info.uid, process.getuid(), "output root owner differs");
  return absolute;
}

async function run(argv) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (code, signal) =>
      done({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

const directory = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(directory, "../../..");
const registryPath = join(runtime, "installed-registry.json");
const registry = await boundedJson(registryPath);
assert.equal(registry.schemaVersion, "mirrors.installed-registry/v1");
const cli = resolve(runtime, registry.mirrorecmaCli);
const frameworkInput = resolve(runtime, registry.frameworkInput);
const project = join(
  runtime,
  "applications/reference-project",
  `mirror.${mode}.project.json`,
);
const output = await outputRoot(outputArgument);
const name = mode === "correct" ? "replay-correct.json" : "replay-faulty.json";
const resultPath = join(output, name);
const execution = await run([
  cli,
  "replay",
  "--project",
  project,
  "--framework-input",
  frameworkInput,
  "--combination",
  registry.combinationId,
  "--tool-registry",
  registryPath,
  "--result-file",
  resultPath,
]);
const expectedExit = mode === "correct" ? 0 : 1;
assert.equal(
  execution.code,
  expectedExit,
  `installed ${mode} replay failed (${execution.code ?? execution.signal}): ${execution.stderr}`,
);
const result = await boundedJson(resultPath);
assert.equal(result.schema, "mirrorecma.suite-result/v1");
assert.deepEqual(result.cleanup, {
  scope: "local",
  status: "succeeded",
  quiescence: "confirmed",
  bindingStatus: "succeeded",
});
if (mode === "correct") {
  assert.equal(result.outcome, "passed");
  assert.equal(result.conformance, "matched");
  assert.equal(result.acceptance.status, "met");
} else {
  assert.equal(result.outcome, "mismatch");
  assert.equal(result.conformance, "mismatch");
  assert.equal(result.failure?.kind, "mismatch");
  assert.equal(result.failure?.traceIndex, 0);
  assert.equal(result.failure?.stateIndex, 1);
}
console.log(JSON.stringify(result));
