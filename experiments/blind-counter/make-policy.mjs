#!/usr/bin/env node
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA = "mirrorecma.blind-counter-policy-input/v1";
const POLICY_SCHEMA = "mirrorgate.control-policy/v1";
const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function fail(message) {
  throw new Error(message);
}

function exact(value, required) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== required.length ||
      required.some((key) => !Object.hasOwn(value, key))) {
    fail(`configuration must contain exactly: ${required.join(", ")}`);
  }
}

function absolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    fail(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function stringArray(value, label, { absolutePaths = false } = {}) {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((item) => typeof item !== "string" || item.length === 0 || item.includes("\0"))) {
    fail(`${label} must be a nonempty string array`);
  }
  const result = value.map((item) => absolutePaths ? absolute(item, label) : item);
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  return result;
}

function buildProgram(publicProbePaths, privateEnvironmentNames) {
  const runtimeGuard = [
    'import { existsSync } from "node:fs";',
    `const publicProbePaths = ${JSON.stringify(publicProbePaths)};`,
    `const privateEnvironmentNames = ${JSON.stringify(privateEnvironmentNames)};`,
    'if (publicProbePaths.some(existsSync)) throw new Error("synthetic canary entered execution namespace");',
    'if (privateEnvironmentNames.some((name) => Object.hasOwn(process.env, name))) throw new Error("private evaluator environment entered execution namespace");',
    'export async function createAdapter() {',
    '  const submitted = await import("./submitted-adapter.mjs");',
    '  if (typeof submitted.createAdapter !== "function") throw new Error("adapter.mjs must export createAdapter");',
    '  return submitted.createAdapter();',
    '}',
    '',
  ].join("\n");

  return [
    'import { copyFile, writeFile } from "node:fs/promises";',
    'import { existsSync } from "node:fs";',
    `const publicProbePaths = ${JSON.stringify(publicProbePaths)};`,
    `const privateEnvironmentNames = ${JSON.stringify(privateEnvironmentNames)};`,
    'if (publicProbePaths.some(existsSync)) throw new Error("synthetic canary entered build namespace");',
    'if (privateEnvironmentNames.some((name) => Object.hasOwn(process.env, name))) throw new Error("private evaluator environment entered build namespace");',
    'const authoredBuild = await import("file:///source/build.mjs");',
    'if (typeof authoredBuild.runBuild !== "function") throw new Error("build.mjs must export runBuild");',
    'const buildResult = await authoredBuild.runBuild();',
    'if (buildResult !== undefined) throw new Error("runBuild must return undefined");',
    'const authoredAdapter = await import("file:///source/adapter.mjs");',
    'if (typeof authoredAdapter.createAdapter !== "function") throw new Error("adapter.mjs must export createAdapter");',
    'await copyFile("/source/adapter.mjs", "/output/submitted-adapter.mjs");',
    `await writeFile("/output/adapter.mjs", ${JSON.stringify(runtimeGuard)}, { encoding: "utf8", mode: 0o400, flag: "wx" });`,
    'process.stdout.write("BLIND_COUNTER_BUILD_GUARD_OK\\n");',
  ].join("\n");
}

export function makePolicy(input) {
  exact(input, [
    "schema", "outputPath", "submissionRoot", "nodeRuntimeRoot", "gateRoot",
    "publicProbePaths", "privateEnvironmentNames", "policyId", "rootId", "buildPlanId",
  ]);
  if (input.schema !== SCHEMA) fail(`schema must be ${SCHEMA}`);
  const outputPath = absolute(input.outputPath, "outputPath");
  const submissionRoot = absolute(input.submissionRoot, "submissionRoot");
  const nodeRuntimeRoot = absolute(input.nodeRuntimeRoot, "nodeRuntimeRoot");
  const gateRoot = absolute(input.gateRoot, "gateRoot");
  const publicProbePaths = stringArray(input.publicProbePaths, "publicProbePaths", { absolutePaths: true });
  const privateEnvironmentNames = stringArray(input.privateEnvironmentNames, "privateEnvironmentNames");
  const policyId = identifier(input.policyId, "policyId");
  const rootId = identifier(input.rootId, "rootId");
  const buildPlanId = identifier(input.buildPlanId, "buildPlanId");
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) fail("a local Unix uid is required");

  const limits = {
    sessionWallMs: 900_000,
    executionWallMs: 30_000,
    commandCpuSeconds: 30,
    addressSpaceBytes: 4 * 1024 ** 3,
    uidProcesses: 4096,
    openFiles: 128,
    fileBytes: 64 * 1024 ** 2,
    stdoutBytes: 256 * 1024,
    stderrBytes: 256 * 1024,
    snapshotFiles: 128,
    snapshotBytes: 16 * 1024 ** 2,
    tmpBytes: 64 * 1024 ** 2,
    scratchBytes: 128 * 1024 ** 2,
  };
  const build = buildProgram(publicProbePaths, privateEnvironmentNames);
  const policy = {
    schema: POLICY_SCHEMA,
    policies: [{
      id: policyId,
      roots: [{ id: rootId, path: submissionRoot, kinds: ["source"], allowedUids: [uid] }],
      buildPlans: [{
        id: buildPlanId,
        command: ["/runtime/node/bin/node", "--input-type=module", "-e", build],
        cwd: ".",
        artifactPath: ".",
      }],
      tools: [
        { id: "node", command: ["/runtime/node/bin/node"], argumentMode: "append" },
        { id: "python", command: ["/usr/bin/python3", "-I", "-S"], argumentMode: "append" },
      ],
      runtimes: [{
        id: "node-v1",
        kind: "node",
        runtimeMounts: [
          { source: "/usr", destination: "/usr" },
          { source: nodeRuntimeRoot, destination: "/runtime/node" },
        ],
        command: [
          "/runtime/node/bin/node",
          "/runtime/mirrorgate-node-shim/runtimes/node/worker.mjs",
          "--manifest", "/runtime/mirrorgate-manifest/port.json",
          "--adapter", "/artifact/adapter.mjs",
        ],
        artifactEntry: "adapter.mjs",
        descriptorSchema: "mirrors.model-interface-descriptor/v1",
        adapterId: "counter.generated-async-v1",
        targetProfile: "mirrorecma-async-v1",
        stateComputerContractVersion: "mirrors.async-state-computer/v1",
        nodeShim: {
          root: gateRoot,
          workerPath: "runtimes/node/worker.mjs",
          protocolPath: "sdk/node/protocol.mjs",
        },
      }],
      limits,
    }],
  };
  return { outputPath, policy, publicProbePaths, submissionRoot, nodeRuntimeRoot, gateRoot };
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--config") {
    fail("usage: node make-policy.mjs --config /absolute/operator-config.json");
  }
  const configPath = absolute(process.argv[3], "config path");
  const input = JSON.parse(await readFile(configPath, "utf8"));
  const { outputPath, policy, publicProbePaths, submissionRoot, nodeRuntimeRoot, gateRoot } = makePolicy(input);
  for (const path of publicProbePaths) {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) fail("each public synthetic canary must be a regular unlinked file");
    if ([submissionRoot, nodeRuntimeRoot, gateRoot].some((root) => path === root || path.startsWith(`${root}/`))) {
      fail("public synthetic canaries must be outside submission and runtime roots");
    }
  }
  if ([submissionRoot, nodeRuntimeRoot, gateRoot].some((root) =>
    outputPath === root || outputPath.startsWith(`${root}/`))) {
    fail("policy output must be outside submission and runtime roots");
  }
  await writeFile(outputPath, `${JSON.stringify(policy)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ status: "written", outputPath })}\n`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "/")).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "policy generation failed"}\n`);
    process.exitCode = 1;
  });
}
