// Run from the MirrorECMA root. Every state and type comes from Apalache output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const model = "examples/work-queue/specs/WorkQueue.tla";
const artifacts = "examples/work-queue/artifacts";
const apalache = process.env.APALACHE_MC ?? "apalache-mc";
const compiler = process.env.MODEL_INTERFACE_GEN ?? resolve(
  process.env.MIRRORS_ROOT ?? "../Mirrors", ".lake/build/bin/model_interface_gen",
);

function run(command, args, expected = 0) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${command} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

const scratch = await mkdtemp(join(tmpdir(), "mirrorecma-queue-generation-"));
try {
  const version = run(apalache, ["version"]).trim();
  const flags = ["check", "--init=Init", "--next=WitnessNext", "--inv=TraceComplete", "--length=15", "--view=View", model];
  const output = run(apalache, [`--out-dir=${join(scratch, "out")}`, `--run-dir=${join(scratch, "witness")}`, ...flags], 12);
  assert.match(output, /State 15: state invariant 0 violated/);
  await copyFile(join(scratch, "witness/violation1.itf.json"), join(artifacts, "witness.itf.json"));
  const lock = join(artifacts, "WorkQueue.mirror-interface.lock.json");
  run(compiler, ["resolve", "--spec", model, "--contract", join(artifacts, "WorkQueue.mirror-interface.json"),
    "--evidence", join(artifacts, "witness.itf.json"), "--param-var", "parameters", "--lock", lock]);
  run(compiler, ["generate", "--lock", lock, "--target", "mirrorecma-v1", "--out", join(artifacts, "generated")]);
  run(compiler, ["preflight", "--lock", lock, "--trace", join(artifacts, "witness.itf.json"), "--require-all-actions"]);
  const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
  await writeFile(join(artifacts, "provenance.json"), `${JSON.stringify({
    schema: "mirrorecma.example-witness/v1",
    generator: "Apalache",
    version,
    command: ["apalache-mc", ...flags],
    expectedExitCode: 12,
    reason: "TraceComplete is deliberately false at state 15 to request the witness trace.",
    modelSha256: await digest(model),
    traceSha256: await digest(join(artifacts, "witness.itf.json")),
    states: 16,
    transitions: 15,
  }, null, 2)}\n`);
  console.log("Generated real WorkQueue witness, provenance, semantic lock, and v1 TypeScript artifacts.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
