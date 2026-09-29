#!/usr/bin/env node
/** R4 prefix-reduction driver (Mirrors Plans/m3-safe-reduction-design.md).
 *  Replays prefixes of the recorded failing trace against a fresh SUT per
 *  candidate and reports the bounded reduction transcript. The original
 *  reproduction bundle is authoritative and never mutated. No model checker
 *  is used: candidate validity is structural (prefixes of the fixed trace). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  decodeReproductionBundle,
  reduceReproductionPrefix,
  reproduceProjectCorpusPrefixWithCatalog,
} from "../dist/index.js";
import { parseBoundedJsonValue } from "../dist/reproduction-bundle.js";

const usage =
  "Usage: node scripts/reduce-reproduction-prefix.mjs --project FILE --bundle FILE --stability FILE --original-trace FILE --framework-input FILE --combination ID --evidence-envelope FILE --output-root DIRECTORY [--trace-index N] [--candidate-limit N] [--total-budget-ms N] [--per-candidate-budget-ms N] [--cleanup-budget-ms N] [--server FILE] [--tool-registry FILE] [--artifact-store DIRECTORY]";
const POLICY_DEFAULTS = {
  candidateLimit: 64,
  totalBudgetMs: 600_000,
  perCandidateBudgetMs: 60_000,
  cleanupBudgetMs: 10_000,
};
const POLICY_FLAGS = {
  "--candidate-limit": "candidateLimit",
  "--total-budget-ms": "totalBudgetMs",
  "--per-candidate-budget-ms": "perCandidateBudgetMs",
  "--cleanup-budget-ms": "cleanupBudgetMs",
};
const flags = Object.create(null);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || Object.hasOwn(flags, key))
    throw new Error(usage);
  flags[key] = value;
}
for (const key of [
  "--project",
  "--bundle",
  "--stability",
  "--original-trace",
  "--framework-input",
  "--combination",
  "--evidence-envelope",
  "--output-root",
])
  if (!flags[key]) throw new Error(usage);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
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
        BigInt(total) === after.size,
      `${absolute} changed while reading`,
    );
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}
async function readBoundedJson(path, maxBytes) {
  return parseBoundedJsonValue(await readBounded(path, maxBytes));
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
function boundedInteger(value, label, min, max) {
  const parsed = Number(value);
  assert(
    Number.isSafeInteger(parsed) && parsed >= min && parsed <= max,
    `${label} must be an integer in [${min}, ${max}]`,
  );
  return parsed;
}
function frameworkInput(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "framework input must be an object");
  const keys = Object.keys(value).sort().join(",");
  assert(
    keys === "catalogRaw,installation,observed,selectionRef" ||
      keys === "approval,catalogRaw,installation,observed,selectionRef",
    "framework input requires catalogRaw, selectionRef, observed, installation, and optional approval",
  );
  assert(typeof value.catalogRaw === "string", "framework catalogRaw must be a string");
  const installation = value.installation;
  assert(
    installation &&
      typeof installation === "object" &&
      !Array.isArray(installation) &&
      installation.schema === "mirrorecma.installed-framework-binding/v1" &&
      Array.isArray(installation.executables) &&
      Array.isArray(installation.packages) &&
      Array.isArray(installation.runtimeTrees),
    "framework installation binding is invalid",
  );
  return value;
}
function resolveInstallation(value, base) {
  return {
    ...value,
    executables: value.executables.map((item) => ({ ...item, path: resolve(base, item.path) })),
    packages: value.packages.map((item) => ({
      ...item,
      root: resolve(base, item.root),
      manifest: { ...item.manifest, path: resolve(base, item.manifest.path) },
    })),
    runtimeTrees: value.runtimeTrees.map((item) => ({ ...item, root: resolve(base, item.root) })),
  };
}
function validateStabilityRecord(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "stability record must be an object");
  assert(value.schema === "mirrorecma.reproduction-stability/v1", "stability record schema is invalid");
  for (const key of ["runId", "bundleSha256", "classification", "independence"])
    assert(typeof value[key] === "string", `stability record ${key} is invalid`);
  assert(typeof value.resettable === "boolean", "stability record resettable is invalid");
  return value;
}

let work;
try {
  const bundle = decodeReproductionBundle(
    await readBounded(flags["--bundle"], 8_388_608),
  );
  const stability = validateStabilityRecord(
    await readBoundedJson(flags["--stability"], 1_048_576),
  );
  const trace = await readBoundedJson(flags["--original-trace"], 16 * 1024 * 1024);
  assert(
    trace && typeof trace === "object" && Array.isArray(trace.states) && trace.states.length > 0,
    "original trace has no states",
  );
  const traceIndex = flags["--trace-index"] !== undefined
    ? boundedInteger(flags["--trace-index"], "trace index", 0, 4096)
    : (bundle.signature.primary?.traceIndex ?? 0);
  assert(
    bundle.evidenceLinks.catalogSelectionRef.selectionKind === "sha256",
    "prefix reduction requires a canonical catalog SHA-256 selection",
  );
  const frameworkPath = resolve(flags["--framework-input"]);
  const framework = frameworkInput(await readBoundedJson(frameworkPath, 8_388_608));
  assert.equal(
    framework.selectionRef?.selectionValue,
    bundle.evidenceLinks.catalogSelectionRef.selectionValue,
    "framework input selection does not match reproduction bundle",
  );
  assert.equal(
    framework.selectionRef?.selectionKind,
    bundle.evidenceLinks.catalogSelectionRef.selectionKind,
    "framework input selection kind does not match reproduction bundle",
  );
  const installation = resolveInstallation(framework.installation, dirname(frameworkPath));
  const policy = { ...POLICY_DEFAULTS };
  for (const [flag, field] of Object.entries(POLICY_FLAGS))
    if (flags[flag] !== undefined)
      policy[field] = boundedInteger(flags[flag], flag, 1, 0x7fffffff);
  const outputRoot = resolve(flags["--output-root"]);
  {
    const handle = await open(outputRoot, constants.O_RDONLY);
    try {
      const info = await handle.stat();
      assert(info.isDirectory(), "output root must be a directory");
      assert((info.mode & 0o777) === 0o700, "output root must be mode 0700");
    } finally {
      await handle.close();
    }
  }
  work = await mkdtemp(join(tmpdir(), "prefix-reduction-"));
  const controller = new AbortController();
  const stop = () => controller.abort("driver interrupted");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let evidenceValidated = false;
  const validateEvidenceOnce = async () => {
    if (evidenceValidated) return;
    const envelopeRaw = await readBounded(flags["--evidence-envelope"], 8_388_608);
    const envelope = parseBoundedJsonValue(envelopeRaw);
    const links = bundle.evidenceLinks;
    assert.equal(sha256(envelopeRaw), links.runRef.envelopeSha256, "evidence envelope does not match runRef");
    assert.equal(envelope?.schemaVersion, links.runRef.schemaVersion, "evidence schemaVersion mismatch");
    assert.equal(envelope?.runId, links.runRef.runId, "evidence runId mismatch");
    assert.equal(envelope?.projectionKind, links.runRef.projectionKind, "evidence projectionKind mismatch");
    const artifacts = Array.isArray(envelope?.artifacts) ? envelope.artifacts : [];
    for (const reference of links.artifactRefs) {
      const found = artifacts.find((item) => item?.artifactId === reference.artifactId);
      assert(
        found &&
          found.sha256 === reference.sha256 &&
          found.bytes === reference.bytes &&
          found.role === reference.role,
        `evidence artifact mismatch: ${reference.artifactId}`,
      );
    }
    evidenceValidated = true;
  };

  const result = await reduceReproductionPrefix(bundle, {
    traceIndex,
    steps: trace.states,
    stability,
    resettable: stability.resettable,
    policy,
    signal: controller.signal,
    validateCandidate: async () => ({ valid: true }),
    evaluateCandidate: async (prefix, signal) => {
      await validateEvidenceOnce();
      const corpusTraceFile = join(
        work,
        `candidate-prefix-${prefix.length}.trace.json`,
      );
      await writeExclusive(
        corpusTraceFile,
        Buffer.from(`${JSON.stringify({ ...trace, states: [...prefix] })}\n`),
      );
      return reproduceProjectCorpusPrefixWithCatalog(flags["--project"], bundle, {
        signal,
        ...(flags["--tool-registry"] ? { installedRegistry: flags["--tool-registry"] } : {}),
        tools: flags["--server"] ? { server: flags["--server"] } : {},
        combinationId: flags["--combination"],
        catalogSelection: bundle.evidenceLinks.catalogSelectionRef,
        catalogRaw: framework.catalogRaw,
        frameworkObserved: framework.observed,
        frameworkApproval: framework.approval,
        installation,
      });
    },
  });
  await writeExclusive(
    join(outputRoot, "prefix-reduction-result.json"),
    Buffer.from(`${JSON.stringify(result, null, 2)}\n`),
  );
  await rm(work, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      status: result.claim,
      bestPrefixLength: result.bestPrefixLength,
      minimalityComplete: result.minimalityComplete,
      stopReason: result.stopReason,
      candidates: result.candidates.length,
    }),
  );
} catch (error) {
  if (work)
    await rm(work, { recursive: true, force: true }).catch(() => {});
  console.error(
    JSON.stringify({
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 1024) : "unknown error",
    }),
  );
  process.exitCode = 1;
}
