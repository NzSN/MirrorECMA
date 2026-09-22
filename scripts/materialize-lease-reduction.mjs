#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeMirrorMessage,
  decodeReproductionBundle,
  encodeState,
  materializeLeaseReductionTrace,
  reproductionBundleSha256,
  spawnMirror,
  startExploreSession,
  validateLeaseReductionCandidate,
} from "../dist/index.js";
import { parseBoundedJsonValue } from "../dist/reproduction-bundle.js";

const usage =
  "Usage: node scripts/materialize-lease-reduction.mjs --candidate FILE --bundle FILE --model FILE --lock FILE --original-trace FILE --tool-manifest FILE --out NEW_FILE --receipt NEW_FILE";
const SHA256 = /^[a-f0-9]{64}$/;
const KNOWN_APALACHE_JAR_SHA256 =
  "33611081942d392646af60993c599907f1f41752fce4a62304dbf9e2cdad4346";
const KNOWN_JAVA_ARCHIVE_SHA256 =
  "75894d107e474ffb6c947ab050e3893e0a1d3d40d36f107d42936ac6088769c1";
const flags = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || Object.hasOwn(flags, key))
    throw new Error(usage);
  flags[key] = value;
}
for (const key of [
  "--candidate",
  "--bundle",
  "--model",
  "--lock",
  "--original-trace",
  "--tool-manifest",
  "--out",
  "--receipt",
])
  if (!flags[key]) throw new Error(usage);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const exactKeys = (value, keys, label) => {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields are invalid`);
  return value;
};
async function readBounded(path, maxBytes) {
  const absolute = resolve(path);
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    assert(before.isFile(), `${absolute} must be a regular non-symlink file`);
    assert(before.size <= BigInt(maxBytes), `${absolute} exceeds ${maxBytes} bytes`);
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65_536, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      assert(total <= maxBytes, `${absolute} exceeds ${maxBytes} bytes`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    assert(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        BigInt(total) === after.size,
      `${absolute} changed while reading`,
    );
    return { absolute, bytes: Buffer.concat(chunks, total) };
  } finally {
    await handle.close();
  }
}
async function readBoundedJson(path, maxBytes) {
  const input = await readBounded(path, maxBytes);
  return { ...input, value: parseBoundedJsonValue(input.bytes) };
}
async function fileSha(path, maxBytes = 512 * 1024 * 1024) {
  return sha256((await readBounded(path, maxBytes)).bytes);
}
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return `${result.stdout}${result.stderr}`.trim();
}
async function writeExclusive(path, bytes) {
  const handle = await open(resolve(path), "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function boundedSettlement(promise, budgetMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "completed", value }),
        (error) => ({ status: "failed", error }),
      ),
      new Promise((resolvePromise) => {
        timer = setTimeout(
          () => resolvePromise({ status: "timed_out" }),
          budgetMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function validateToolManifest(value) {
  const manifest = exactKeys(
    value,
    [
      "schema",
      "totalBudgetMs",
      "cleanupBudgetMs",
      "mirror",
      "validator",
      "apalache",
      "java",
    ],
    "tool manifest",
  );
  assert.equal(manifest.schema, "mirrorecma.lease-reduction-tools/v1");
  for (const key of ["totalBudgetMs", "cleanupBudgetMs"])
    assert(
      Number.isSafeInteger(manifest[key]) &&
        manifest[key] >= 1 &&
        manifest[key] <= 0x7fffffff,
      `${key} must be a positive bounded integer`,
    );
  exactKeys(manifest.mirror, ["path", "sha256"], "mirror identity");
  exactKeys(manifest.validator, ["id", "path", "sha256"], "validator identity");
  exactKeys(
    manifest.apalache,
    ["version", "launcherPath", "launcherSha256", "jarPath", "jarSha256"],
    "Apalache identity",
  );
  exactKeys(
    manifest.java,
    [
      "selectedVersion",
      "observedVersion",
      "home",
      "executablePath",
      "executableSha256",
      "archivePath",
      "archiveSha256",
      "distributionQualified",
      "qualificationRef",
    ],
    "Java identity",
  );
  const digests = [
    manifest.mirror.sha256,
    manifest.validator.sha256,
    manifest.apalache.launcherSha256,
    manifest.apalache.jarSha256,
    manifest.java.executableSha256,
    manifest.java.archiveSha256,
  ];
  assert(digests.every((digest) => SHA256.test(digest)), "tool digests must be lowercase SHA-256");
  assert.equal(manifest.validator.id, "mirrors.model-interface-reduction/v1");
  assert.equal(manifest.apalache.version, "0.61.0");
  assert.equal(manifest.apalache.jarSha256, KNOWN_APALACHE_JAR_SHA256);
  assert.equal(manifest.java.selectedVersion, "25.0.4+7");
  assert.equal(manifest.java.observedVersion, "25.0.4+7-LTS");
  assert.equal(manifest.java.archiveSha256, KNOWN_JAVA_ARCHIVE_SHA256);
  assert.equal(manifest.java.distributionQualified, true);
  assert.equal(
    manifest.java.qualificationRef,
    `microsoft-jdk-25.0.4+7-linux-x64/sha256:${KNOWN_JAVA_ARCHIVE_SHA256}`,
  );
  return manifest;
}
async function verifyTools(manifest) {
  const observed = {
    mirror: await fileSha(manifest.mirror.path),
    validator: await fileSha(manifest.validator.path),
    apalacheLauncher: await fileSha(manifest.apalache.launcherPath, 1024 * 1024),
    apalacheJar: await fileSha(manifest.apalache.jarPath),
    javaExecutable: await fileSha(manifest.java.executablePath),
    javaArchive: await fileSha(manifest.java.archivePath),
  };
  assert.equal(observed.mirror, manifest.mirror.sha256, "Mirror identity mismatch");
  assert.equal(observed.validator, manifest.validator.sha256, "validator identity mismatch");
  assert.equal(observed.apalacheLauncher, manifest.apalache.launcherSha256, "Apalache launcher identity mismatch");
  assert.equal(observed.apalacheJar, manifest.apalache.jarSha256, "Apalache JAR identity mismatch");
  assert.equal(observed.javaExecutable, manifest.java.executableSha256, "Java executable identity mismatch");
  assert.equal(observed.javaArchive, manifest.java.archiveSha256, "Java archive identity mismatch");
  return observed;
}

let cleanup = { status: "not_started" };
try {
  const candidateInput = await readBoundedJson(flags["--candidate"], 256 * 1024);
  const candidate = validateLeaseReductionCandidate(candidateInput.value);
  const bundleInput = await readBounded(flags["--bundle"], 4 * 1024 * 1024);
  const originalBundle = decodeReproductionBundle(bundleInput.bytes);
  assert.equal(
    reproductionBundleSha256(originalBundle),
    candidate.originalBundleSha256,
    "candidate original bundle identity mismatch",
  );
  assert.equal(originalBundle.identities.corpus.traceCount, 2, "selected profile requires exactly two trace occurrences");
  assert.equal(
    originalBundle.identities.corpus.orderedOccurrencesSha256,
    candidate.orderedCorpusSha256,
    "candidate corpus identity disagrees with bundle",
  );

  const toolInput = await readBoundedJson(flags["--tool-manifest"], 256 * 1024);
  const tools = validateToolManifest(toolInput.value);
  const beforeTools = await verifyTools(tools);
  run(resolve(tools.validator.path), ["validate", candidateInput.absolute]);

  const modelInput = await readBounded(flags["--model"], 1024 * 1024);
  const lockInput = await readBoundedJson(flags["--lock"], 4 * 1024 * 1024);
  const lock = lockInput.value;
  assert.equal(sha256(modelInput.bytes), candidate.modelSha256, "candidate model identity mismatch");
  assert.equal(lock.semanticDigest, candidate.interfaceDigest, "candidate interface identity mismatch");

  const originalInput = await readBoundedJson(flags["--original-trace"], 16 * 1024 * 1024);
  const original = originalInput.value;
  assert(original && typeof original === "object" && Array.isArray(original.states), "original trace has no states");
  const originalTraceSha256 = sha256(originalInput.bytes);
  assert.equal(
    originalTraceSha256,
    candidate.selectedTraceSha256,
    "selected trace identity mismatch",
  );
  const orderedCorpusSha256 = sha256(
    JSON.stringify({
      schema: "mirrorecma.corpus/v1",
      traces: candidate.traceOccurrences.map(() => originalTraceSha256),
    }),
  );
  assert.equal(orderedCorpusSha256, candidate.orderedCorpusSha256, "candidate corpus identity mismatch");

  const materialized = materializeLeaseReductionTrace(original, candidate);
  const transformed = materialized.trace;
  const changed = materialized.changedPaths;

  process.env.APALACHE_MC = resolve(tools.apalache.launcherPath);
  process.env.PATH = `${resolve(tools.java.home, "bin")}:${process.env.PATH ?? ""}`;
  const apalacheVersion = run(resolve(tools.apalache.launcherPath), ["version"]);
  assert.match(apalacheVersion, /0\.61\.0/, "unexpected Apalache version");
  const javaVersion = run(resolve(tools.java.executablePath), ["-version"]);
  assert.match(javaVersion, /25\.0\.4\+7-LTS/, "unexpected Java version");

  const transport = spawnMirror(resolve(tools.mirror.path));
  let session;
  let deadlineTimer;
  let timedOut = false;
  const explore = (async () => {
    session = await startExploreSession(
      transport,
      { sources: [new TextDecoder("utf-8", { fatal: true }).decode(modelInput.bytes)] },
      ["Safety"],
      [],
    );
    assert.equal(session.ready.initTransitions, 1, "original Init profile changed");
    assert.equal(session.ready.nextTransitions, 5, "original Next profile changed");
    const transitionIdByWireAction = {
      init: 0,
      acquire: 0,
      renew: 2,
      release: 3,
      write: 4,
      advance: 1,
    };
    for (let stateIndex = 0; stateIndex < transformed.states.length; stateIndex++) {
      const stateRaw = Object.fromEntries(
        Object.entries(transformed.states[stateIndex]).filter(
          ([key]) => !key.startsWith("#"),
        ),
      );
      const decoded = decodeMirrorMessage(
        JSON.stringify({
          proto_step: "initial_state",
          action: stateRaw.action_taken,
          state: stateRaw,
        }),
      );
      if (decoded.proto_step !== "initial_state")
        throw new Error("candidate state decoding failed");
      const transitionId = transitionIdByWireAction[stateRaw.action_taken];
      const count =
        stateIndex === 0
          ? session.ready.initTransitions
          : session.ready.nextTransitions;
      assert(
        Number.isSafeInteger(transitionId) && transitionId < count,
        `candidate state ${stateIndex} has no selected original transition`,
      );
      if ((await session.assumeTransition(transitionId)) !== "ENABLED")
        throw new Error(
          `candidate state ${stateIndex} transition is disabled by original ${stateIndex === 0 ? "Init" : "Next"}`,
        );
      await session.nextStep();
      if ((await session.assumeState(decoded.state)) !== "ENABLED")
        throw new Error(
          `candidate state ${stateIndex} is not admitted by original ${stateIndex === 0 ? "Init" : "Next"}`,
        );
      const actual = Object.fromEntries(
        Object.entries(encodeState(await session.queryState())).filter(
          ([key]) => !key.startsWith("#"),
        ),
      );
      assert.equal(
        canonical(actual),
        canonical(stateRaw),
        `candidate state ${stateIndex} changed after original relation admission`,
      );
    }
    await session.done();
    cleanup = { status: "confirmed", method: "explore_done" };
  })();
  void explore.catch(() => {});
  const boundary = new Promise((_, reject) => {
    deadlineTimer = setTimeout(async () => {
      timedOut = true;
      const closed = await boundedSettlement(
        Promise.resolve().then(() => transport.close()),
        tools.cleanupBudgetMs,
      );
      cleanup = {
        status: closed.status === "completed" ? "confirmed" : "unconfirmed",
        method: "forced_transport_close",
      };
      reject(new Error("model oracle total budget exceeded"));
    }, tools.totalBudgetMs);
  });
  try {
    await Promise.race([explore, boundary]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (!timedOut && cleanup.status !== "confirmed") {
      const closed = await boundedSettlement(
        Promise.resolve().then(() => transport.close()),
        tools.cleanupBudgetMs,
      );
      cleanup = {
        status: closed.status === "completed" ? "confirmed" : "unconfirmed",
        method: "forced_transport_close",
      };
    }
  }
  assert.equal(cleanup.status, "confirmed", "model oracle cleanup was not confirmed");

  const afterTools = await verifyTools(tools);
  assert.deepEqual(afterTools, beforeTools, "selected tool bytes drifted during oracle execution");
  assert.equal(sha256((await readBounded(modelInput.absolute, 1024 * 1024)).bytes), candidate.modelSha256, "model source drifted during oracle execution");
  assert.equal(sha256((await readBounded(originalInput.absolute, 16 * 1024 * 1024)).bytes), originalTraceSha256, "original trace drifted during oracle execution");

  const outputBytes = Buffer.from(`${JSON.stringify(transformed, null, 2)}\n`);
  const candidateTraceSha256 = sha256(outputBytes);
  const candidateCorpusSha256 = sha256(
    JSON.stringify({
      schema: "mirrorecma.corpus/v1",
      traces: candidate.traceOccurrences.map(() => candidateTraceSha256),
    }),
  );
  const receipt = {
    schema: "mirrorecma.lease-reduction-oracle/v1",
    status: "model_valid",
    profile: "lease-service-input-shrink/v1",
    domainVersion: "LeaseService.Next/v1",
    modelSha256: candidate.modelSha256,
    interfaceDigest: candidate.interfaceDigest,
    originalCorpusSha256: candidate.orderedCorpusSha256,
    candidateCorpusSha256,
    selectedTraceSha256: candidate.selectedTraceSha256,
    traceOccurrences: candidate.traceOccurrences,
    validator: {
      id: tools.validator.id,
      sha256: tools.validator.sha256,
    },
    apalache: {
      version: tools.apalache.version,
      sha256: tools.apalache.jarSha256,
    },
    java: {
      observedVersion: tools.java.observedVersion,
      selectedVersion: tools.java.selectedVersion,
      executableSha256: tools.java.executableSha256,
      archiveSha256: tools.java.archiveSha256,
      distributionQualified: tools.java.distributionQualified,
      qualificationRef: tools.java.qualificationRef,
    },
    cleanup,
    materialization: {
      originalTraceSha256,
      candidateTraceSha256,
      originalBundleSha256: candidate.originalBundleSha256,
      actionSequence: transformed.states.map((state) => state.action_taken),
      inputMeasure: {
        before: candidate.edits.reduce((sum, edit) => sum + edit.before, 0),
        after: candidate.edits.reduce((sum, edit) => sum + edit.after, 0),
      },
      changes: changed,
      toolManifestSha256: sha256(toolInput.bytes),
      sources: {
        model: { path: modelInput.absolute, sha256: candidate.modelSha256 },
        lock: { path: lockInput.absolute, sha256: sha256(lockInput.bytes) },
        originalTrace: { path: originalInput.absolute, sha256: originalTraceSha256 },
        candidateRequest: { path: candidateInput.absolute, sha256: sha256(candidateInput.bytes) },
      },
    },
  };
  await writeExclusive(flags["--out"], outputBytes);
  await writeExclusive(flags["--receipt"], `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ status: "model_valid", candidateTraceSha256 }));
} catch (error) {
  const failure = {
    schema: "mirrorecma.lease-reduction-materialization/v1",
    status: "inconclusive",
    reasonCode:
      error instanceof Error && error.message.includes("budget")
        ? "model_oracle_timeout"
        : "model_oracle_error",
    cleanup,
    error: error instanceof Error ? error.message.slice(0, 1024) : "unknown error",
  };
  try {
    await writeExclusive(flags["--receipt"], `${JSON.stringify(failure, null, 2)}\n`);
  } catch {
    // Preserve the primary failure when the requested receipt path is unavailable.
  }
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
}
