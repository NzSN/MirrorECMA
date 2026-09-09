#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const CONFIG_SCHEMA = "mirrorecma.blind-counter-evaluator/v1";
const READY_SCHEMA = "mirrorecma.blind-counter-broker-ready/v1";
const CONTRACT_SCHEMA = "mirrorecma.blind-counter-author/v1";
const EVIDENCE_SCHEMA = "mirrorecma.blind-counter-evidence/v1";
const BROKER_PROTOCOL = "mirrorecma.blind-counter-broker/v1";
const REQUEST_BYTES = 65_536;
const RESPONSE_BYTES = 262_144;
const RETAINED_STREAM_BYTES = 65_535;
const PUBLIC_TOOLS = new Map([
  ["author.node", "node"],
  ["author.python", "python"],
]);
const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function failure(message) {
  throw new Error(message);
}

function exact(value, required) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === required.length &&
    required.every((key) => Object.hasOwn(value, key));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function absolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    failure(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) failure(`${label} is invalid`);
  return value;
}

function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) failure(`${label} must be a positive safe integer`);
  return value;
}

function boundedString(value, label, bytes = 4_096) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > bytes) failure(`${label} is invalid`);
  return value;
}

function privateStrings(value, label, { paths = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) failure(`${label} must be nonempty`);
  const result = value.map((item) => paths ? absolute(item, label) : boundedString(item, label, 128));
  if (new Set(result).size !== result.length) failure(`${label} contains duplicates`);
  return result;
}

function containsPrivatePathString(value, privatePaths) {
  if (typeof value === "string") return privatePaths.some((path) => value.includes(path));
  if (Array.isArray(value)) return value.some((item) => containsPrivatePathString(item, privatePaths));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => containsPrivatePathString(item, privatePaths));
  }
  return false;
}

function pathWithin(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function auditPolicy(policyDocument, config) {
  const policies = Array.isArray(policyDocument?.policies) ? policyDocument.policies : [];
  const policy = policies.find((item) => item?.id === config.gatePolicyId);
  if (policy === undefined) failure("selected Gate policy is absent");
  const root = Array.isArray(policy.roots)
    ? policy.roots.find((item) => item?.id === config.submissionRootId)
    : undefined;
  const runtime = Array.isArray(policy.runtimes)
    ? policy.runtimes.find((item) => item?.id === "node-v1")
    : undefined;
  if (root === undefined || typeof root.path !== "string" || runtime === undefined ||
      !Array.isArray(runtime.runtimeMounts)) failure("selected Gate root or runtime is absent");
  const submissionRoot = resolve(root.path);
  const expectedSubmission = resolve(submissionRoot, config.submissionRelativePath);
  if (expectedSubmission !== config.submissionDirectory) {
    failure("submissionDirectory disagrees with the selected Gate root and relative path");
  }
  const runtimeRoots = runtime.runtimeMounts.map((mount) => absolute(mount.source, "runtime mount source"));
  if (config.privateProbePaths.some((path) => pathWithin(path, submissionRoot) ||
      runtimeRoots.some((runtimeRoot) => pathWithin(path, runtimeRoot)))) {
    failure("an evaluator-private path is inside a submission or runtime mount");
  }
  if (containsPrivatePathString(policyDocument, config.privateProbePaths)) {
    failure("Gate policy or fixed build/runtime commands disclose an actual evaluator-private path");
  }
  return Object.freeze({
    selectedPolicy: true,
    submissionBindingMatched: true,
    privatePathsOutsideSubmissionAndRuntimeMounts: true,
    privatePathStringsAbsentFromPolicy: true,
  });
}

async function treeContainsPrivatePathString(root, privatePaths) {
  const names = await readdir(root, { withFileTypes: true });
  for (const entry of names) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (await treeContainsPrivatePathString(path, privatePaths)) return true;
    } else if (entry.isFile()) {
      const bytes = await readFile(path);
      if (privatePaths.some((privatePath) => bytes.includes(Buffer.from(privatePath, "utf8")))) return true;
    }
  }
  return false;
}

async function loadConfig(configPath) {
  const value = JSON.parse(await readFile(configPath, "utf8"));
  const fields = [
    "schema", "mirrorEcmaCompiledRoot", "gateSdkRoot", "gateCommand", "gatePolicyFile",
    "gatePolicyId", "submissionRootId", "submissionRelativePath", "submissionDirectory",
    "buildPlanId", "mirrorBinary", "counterInterfaceLockPath", "privateSpecPath", "privateTracePaths", "invariant",
    "constInit", "lengthBound", "modelRevisionId", "privateProbePaths",
    "privateEnvironmentNames", "evidencePath", "registrationMs", "stepMs", "receiveMs",
  ];
  if (!exact(value, fields)) failure(`configuration must contain exactly: ${fields.join(", ")}`);
  if (value.schema !== CONFIG_SCHEMA) failure(`configuration schema must be ${CONFIG_SCHEMA}`);
  const config = {
    schema: value.schema,
    mirrorEcmaCompiledRoot: absolute(value.mirrorEcmaCompiledRoot, "mirrorEcmaCompiledRoot"),
    gateSdkRoot: absolute(value.gateSdkRoot, "gateSdkRoot"),
    gateCommand: absolute(value.gateCommand, "gateCommand"),
    gatePolicyFile: absolute(value.gatePolicyFile, "gatePolicyFile"),
    gatePolicyId: identifier(value.gatePolicyId, "gatePolicyId"),
    submissionRootId: identifier(value.submissionRootId, "submissionRootId"),
    submissionRelativePath: boundedString(value.submissionRelativePath, "submissionRelativePath", 1_024),
    submissionDirectory: absolute(value.submissionDirectory, "submissionDirectory"),
    buildPlanId: identifier(value.buildPlanId, "buildPlanId"),
    mirrorBinary: absolute(value.mirrorBinary, "mirrorBinary"),
    counterInterfaceLockPath: absolute(value.counterInterfaceLockPath, "counterInterfaceLockPath"),
    privateSpecPath: absolute(value.privateSpecPath, "privateSpecPath"),
    privateTracePaths: privateStrings(value.privateTracePaths, "privateTracePaths", { paths: true }),
    invariant: boundedString(value.invariant, "invariant", 128),
    constInit: boundedString(value.constInit, "constInit", 128),
    lengthBound: positive(value.lengthBound, "lengthBound"),
    modelRevisionId: identifier(value.modelRevisionId, "modelRevisionId"),
    privateProbePaths: privateStrings(value.privateProbePaths, "privateProbePaths", { paths: true }),
    privateEnvironmentNames: privateStrings(value.privateEnvironmentNames, "privateEnvironmentNames"),
    evidencePath: absolute(value.evidencePath, "evidencePath"),
    registrationMs: positive(value.registrationMs, "registrationMs"),
    stepMs: positive(value.stepMs, "stepMs"),
    receiveMs: positive(value.receiveMs, "receiveMs"),
  };
  if (config.registrationMs <= 5_000) failure("registrationMs must leave time for broker shutdown");
  if (config.submissionRelativePath === "." || config.submissionRelativePath.startsWith("/") ||
      config.submissionRelativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    failure("submissionRelativePath must name a dedicated child directory");
  }
  const requiredPrivatePaths = [
    configPath,
    config.gatePolicyFile,
    config.counterInterfaceLockPath,
    config.privateSpecPath,
    ...config.privateTracePaths,
  ].map((path) => resolve(path));
  if (requiredPrivatePaths.some((item) => !config.privateProbePaths.includes(item))) {
    failure("privateProbePaths must include the evaluator config, Gate policy, private spec, and every private trace");
  }
  for (const name of config.privateEnvironmentNames) {
    if (!Object.hasOwn(process.env, name)) failure(`private evaluator environment canary is unset: ${name}`);
  }
  return Object.freeze(config);
}

async function requireRegularFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1) failure(`${label} must be a regular unlinked file`);
}

async function requireDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory()) failure(`${label} must be a directory`);
}

async function treeIdentity(root) {
  const entries = [];
  async function visit(directory, relative, depth) {
    if (depth > 64) failure("source tree nesting exceeds 64 levels");
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
        failure("source tree contains an invalid name");
      }
      const path = resolve(directory, name);
      const rel = relative.length === 0 ? name : `${relative}/${name}`;
      const before = await lstat(path);
      if (before.isSymbolicLink()) failure("source tree contains a symbolic link");
      if (before.isDirectory()) {
        entries.push({ path: rel, kind: "directory" });
        await visit(path, rel, depth + 1);
      } else if (before.isFile() && before.nlink === 1) {
        const bytes = await readFile(path);
        const after = await lstat(path);
        if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
            before.nlink !== after.nlink || before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          failure("source tree changed while hashing");
        }
        entries.push({
          path: rel,
          kind: "file",
          size: bytes.byteLength,
          sha256: sha256(bytes),
          executable: (before.mode & 0o111) !== 0,
        });
      } else {
        failure("source tree contains a linked or special file");
      }
    }
  }
  await visit(root, "", 0);
  return Object.freeze({ entries: Object.freeze(entries), digest: sha256(canonicalJson(entries)) });
}

function outputKey(operationId, stream) {
  return `${operationId}:${stream}`;
}

class GateTelemetry {
  constructor() {
    this.outputs = new Map();
    this.prepared = undefined;
    this.cleanup = undefined;
    this.seal = undefined;
    this.events = new Map();
  }

  receive(event) {
    this.events.set(event.event, (this.events.get(event.event) ?? 0) + 1);
    if (event.event !== "authoring.output" && event.event !== "build.output") return;
    const key = outputKey(event.data.operationId, event.data.stream);
    const entry = this.outputs.get(key) ?? { total: 0, retained: [], chunks: 0 };
    const bytes = Buffer.from(event.data.bytesBase64, "base64");
    entry.total += bytes.byteLength;
    entry.chunks += 1;
    const retained = entry.retained.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (retained < RETAINED_STREAM_BYTES) {
      entry.retained.push(bytes.subarray(0, RETAINED_STREAM_BYTES - retained));
    }
    this.outputs.set(key, entry);
  }

  stream(operationId, stream) {
    const entry = this.outputs.get(outputKey(operationId, stream)) ?? { total: 0, retained: [], chunks: 0 };
    return Object.freeze({
      text: Buffer.concat(entry.retained).toString("utf8"),
      bytes: entry.total,
      chunks: entry.chunks,
      truncated: entry.total > RETAINED_STREAM_BYTES,
    });
  }
}

function wrapOperation(operation, transform) {
  return {
    id: operation.id,
    wait: async (options) => transform(await operation.wait(options), operation.id),
  };
}

/** Accept both control-v1 rejection timings while requiring the same exact code. */
export async function verifyAuthoringSealed(session, telemetry, timeoutMs = 5_000) {
  let late;
  try {
    late = await session.authoringExec({
      toolId: "node",
      arguments: ["--version"],
      cwd: ".",
    }, { timeoutMs });
  } catch (error) {
    if (error === null || typeof error !== "object" || error.code !== "STATE_INVALID") throw error;
    telemetry.seal = Object.freeze({
      status: "failed",
      code: error.code,
      stage: typeof error.stage === "string" ? error.stage : undefined,
      rejection: "immediate",
    });
    return;
  }
  const lateOutcome = await late.wait({ timeoutMs });
  telemetry.seal = Object.freeze({
    status: lateOutcome.status,
    code: lateOutcome.status === "failed" ? lateOutcome.error?.code : undefined,
    stage: lateOutcome.status === "failed" ? lateOutcome.error?.stage : undefined,
    rejection: "operation",
  });
  if (lateOutcome.status !== "failed" || lateOutcome.error?.code !== "STATE_INVALID") {
    failure("Gate accepted authoring after source preparation sealed the session");
  }
}

function instrumentControlClient(ControlClient, telemetry) {
  const originalLaunch = ControlClient.launch;
  const originalConnectUnix = ControlClient.connectUnix;
  const wrapCleanupOperation = (operation) => wrapOperation(operation, async (outcome) => {
    if (outcome.status === "succeeded") telemetry.cleanup = outcome.result;
    return outcome;
  });

  const wrapClient = (client) => ({
    hello: client.hello,
    openSession: async (...args) => {
      const session = await client.openSession(...args);
      session.onEvent((event) => telemetry.receive(event));

      const wrapped = {
        authoringExec: (...args) => session.authoringExec(...args),
        prepare: async (options) => {
          const operation = await session.prepare(options);
          return wrapOperation(operation, async (outcome, operationId) => {
            if (outcome.status !== "succeeded") return outcome;
            telemetry.prepared = Object.freeze({ ...outcome.result });
            const buildStdout = telemetry.stream(operationId, "stdout");
            const buildStderr = telemetry.stream(operationId, "stderr");
            telemetry.buildOutput = Object.freeze({ stdout: buildStdout, stderr: buildStderr });
            await verifyAuthoringSealed(session, telemetry);
            return outcome;
          });
        },
        authorize: (...args) => session.authorize(...args),
        acquireWorker: async (...args) => {
          const reservation = await session.acquireWorker(...args);
          return {
            connect: (...connectArgs) => reservation.connect(...connectArgs),
            release: async (...releaseArgs) => wrapCleanupOperation(await reservation.release(...releaseArgs)),
          };
        },
        cancel: async (...args) => wrapCleanupOperation(await session.cancel(...args)),
        close: async (...args) => wrapCleanupOperation(await session.close(...args)),
        onEvent: (...args) => session.onEvent(...args),
      };
      return wrapped;
    },
    close: () => client.close(),
  });

  ControlClient.launch = async (options) => wrapClient(await originalLaunch.call(ControlClient, options));
  ControlClient.connectUnix = async (options) =>
    wrapClient(await originalConnectUnix.call(ControlClient, options));
  return () => {
    ControlClient.launch = originalLaunch;
    ControlClient.connectUnix = originalConnectUnix;
  };
}

function safeError(error) {
  if (error && typeof error === "object") {
    if (error.code === "STATE_INVALID") return "authoring_sealed";
    if (error.code === "POLICY_DENIED") return "tool_not_approved";
    if (error.code === "LIMIT_EXCEEDED") return "tool_limit_exceeded";
    if (error.code === "DEADLINE_EXCEEDED") return "tool_deadline_exceeded";
    if (error.name === "BrokerRequestError") return error.publicCode;
  }
  return "tool_execution_failed";
}

class BrokerRequestError extends Error {
  constructor(publicCode) {
    super(publicCode);
    this.name = "BrokerRequestError";
    this.publicCode = publicCode;
  }
}

function brokerReject(code) {
  throw new BrokerRequestError(code);
}

class AuthorBroker {
  constructor({ socketPath, readyFile, session, initialSource, publicBundleHash, timeoutMs }) {
    this.socketPath = socketPath;
    this.readyFile = readyFile;
    this.session = session;
    this.initialSource = initialSource;
    this.publicBundleHash = publicBundleHash;
    this.timeoutMs = timeoutMs;
    this.transcript = [];
    this.seenIds = new Set();
    this.submitted = false;
    this.execQueue = Promise.resolve();
    this.server = undefined;
    this.submitPromise = new Promise((resolveSubmit, rejectSubmit) => {
      this.resolveSubmit = resolveSubmit;
      this.rejectSubmit = rejectSubmit;
    });
  }

  contract() {
    return Object.freeze({
      schema: CONTRACT_SCHEMA,
      protocol: BROKER_PROTOCOL,
      files: this.session.files,
      manifest: this.session.publicManifest,
      workspace: Object.freeze({ cwd: ".", sandboxPath: "/workspace", initiallyEmpty: true }),
      tools: Object.freeze([
        Object.freeze({ id: "author.node", runtime: "Node", arguments: "fixed executable plus bounded argv" }),
        Object.freeze({ id: "author.python", runtime: "Python", arguments: "fixed isolated executable plus bounded argv" }),
      ]),
      submission: Object.freeze({ files: Object.freeze(["adapter.mjs", "build.mjs"]), submitOperation: "submit" }),
    });
  }

  validate(request) {
    if (request === null || typeof request !== "object" || Array.isArray(request) ||
        !Number.isSafeInteger(request.id) || request.id <= 0 || this.seenIds.has(request.id)) {
      brokerReject("invalid_request");
    }
    this.seenIds.add(request.id);
    if (request.op === "contract") {
      if (!exact(request, ["id", "op"])) brokerReject("invalid_request");
      return request;
    }
    if (request.op === "submit") {
      if (!exact(request, ["id", "op"])) brokerReject("invalid_request");
      return request;
    }
    if (request.op !== "exec" || !exact(request, ["id", "op", "toolId", "args"]) ||
        !PUBLIC_TOOLS.has(request.toolId) || !Array.isArray(request.args) || request.args.length > 256 ||
        request.args.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.includes("\0")) ||
        request.args.reduce((sum, arg) => sum + Buffer.byteLength(arg, "utf8"), 0) > 65_535) {
      brokerReject(request?.op === "exec" && !PUBLIC_TOOLS.has(request?.toolId)
        ? "tool_not_approved" : "invalid_request");
    }
    return request;
  }

  async dispatch(raw) {
    let request;
    let response;
    try {
      request = this.validate(raw);
      if (request.op === "contract") {
        response = { id: request.id, ok: true, contract: this.contract() };
      } else if (request.op === "submit") {
        if (this.submitted) brokerReject("authoring_sealed");
        this.submitted = true;
        response = { id: request.id, ok: true, status: "submitted" };
        this.resolveSubmit();
      } else {
        if (this.submitted) brokerReject("authoring_sealed");
        const run = async () => {
          const result = await this.session.exec({
            toolId: PUBLIC_TOOLS.get(request.toolId),
            arguments: request.args,
            cwd: ".",
          });
          return {
            id: request.id,
            ok: true,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutBytes: result.stdoutBytes,
            stderrBytes: result.stderrBytes,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
          };
        };
        const pending = this.execQueue.then(run, run);
        this.execQueue = pending.then(() => undefined, () => undefined);
        response = await pending;
      }
    } catch (error) {
      response = {
        id: Number.isSafeInteger(raw?.id) && raw.id > 0 ? raw.id : 0,
        ok: false,
        error: safeError(error),
      };
    }
    const record = Object.freeze({
      ordinal: this.transcript.length + 1,
      request: structuredClone(raw),
      response: structuredClone(response),
    });
    this.transcript.push(record);
    return response;
  }

  async accept(socket) {
    let buffered = Buffer.alloc(0);
    let answered = false;
    const answer = async (response) => {
      if (answered) return;
      answered = true;
      let encoded = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
      if (encoded.byteLength > RESPONSE_BYTES) {
        encoded = Buffer.from(`${JSON.stringify({ id: response.id ?? 0, ok: false, error: "response_limit_exceeded" })}\n`, "utf8");
      }
      socket.end(encoded);
    };
    socket.on("data", (chunk) => {
      if (answered) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > REQUEST_BYTES) {
        void answer({ id: 0, ok: false, error: "request_limit_exceeded" });
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffered.byteLength - 1) {
        void answer({ id: 0, ok: false, error: "invalid_request" });
        return;
      }
      let request;
      try {
        request = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
      } catch {
        void answer({ id: 0, ok: false, error: "invalid_request" });
        return;
      }
      this.dispatch(request).then(answer, () => answer({ id: request?.id ?? 0, ok: false, error: "tool_execution_failed" }));
    });
    socket.on("end", () => {
      if (!answered) void answer({ id: 0, ok: false, error: "invalid_request" });
    });
    socket.on("error", () => {});
  }

  async run() {
    await requireDirectory(dirname(this.socketPath), "broker socket directory");
    const parentMode = (await stat(dirname(this.socketPath))).mode & 0o777;
    if ((parentMode & 0o077) !== 0) failure("broker socket directory must not be accessible by group or other users");
    try {
      await lstat(this.socketPath);
      failure("broker socket path already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await lstat(this.readyFile);
      failure("broker ready file already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.server = createServer((socket) => void this.accept(socket));
    await new Promise((resolveListen, rejectListen) => {
      this.server.once("error", rejectListen);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", rejectListen);
        resolveListen();
      });
    });
    await chmod(this.socketPath, 0o600);
    const ready = {
      schema: READY_SCHEMA,
      protocol: BROKER_PROTOCOL,
      socketPath: this.socketPath,
      allowedToolIds: [...PUBLIC_TOOLS.keys()],
      maxRequestBytes: REQUEST_BYTES,
      maxResponseBytes: RESPONSE_BYTES,
      maxRetainedStreamBytes: RETAINED_STREAM_BYTES,
      publicBundleHash: this.publicBundleHash,
      initialSourceHash: this.initialSource.digest,
      pid: process.pid,
    };
    await writeFile(this.readyFile, `${JSON.stringify(ready)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(`${JSON.stringify({ event: "broker.ready", readyFile: this.readyFile })}\n`);
    const timer = setTimeout(() => this.rejectSubmit(new Error("authoring broker deadline exceeded")), this.timeoutMs);
    try {
      await this.submitPromise;
      await this.execQueue;
    } finally {
      clearTimeout(timer);
      await new Promise((resolveClose) => this.server.close(resolveClose));
      await unlink(this.socketPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    }
  }
}

async function loadPublicFiles() {
  const names = ["COUNTER_CONTRACT.md", "counter-port.d.ts"];
  const files = Object.fromEntries(await Promise.all(names.map(async (name) => [
    name,
    await readFile(resolve(PUBLIC_DIR, name), "utf8"),
  ])));
  return Object.freeze(files);
}

function trustedProbeSource(paths, environmentNames, token) {
  return [
    'import { existsSync } from "node:fs";',
    `const paths = ${JSON.stringify(paths)};`,
    `const environmentNames = ${JSON.stringify(environmentNames)};`,
    'if (paths.some(existsSync)) throw new Error("private evaluator path entered authoring namespace");',
    'if (environmentNames.some((name) => Object.hasOwn(process.env, name))) throw new Error("private evaluator environment entered authoring namespace");',
    `process.stdout.write(${JSON.stringify(token)});`,
  ].join("\n");
}

async function main() {
  if (process.argv.length !== 8 || process.argv[2] !== "--config" ||
      process.argv[4] !== "--broker-socket" || process.argv[6] !== "--ready-file") {
    failure("usage: node evaluator.mjs --config /abs/evaluator.json --broker-socket /abs/broker.sock --ready-file /abs/ready.json");
  }
  const configPath = absolute(process.argv[3], "config path");
  const brokerSocket = absolute(process.argv[5], "broker socket");
  const readyFile = absolute(process.argv[7], "ready file");
  const config = await loadConfig(configPath);
  await Promise.all([
    requireDirectory(config.mirrorEcmaCompiledRoot, "compiled MirrorECMA root"),
    requireDirectory(config.gateSdkRoot, "packed Gate SDK root"),
    requireDirectory(config.submissionDirectory, "submission directory"),
    requireRegularFile(config.gateCommand, "Gate command"),
    requireRegularFile(config.gatePolicyFile, "Gate policy"),
    requireRegularFile(config.mirrorBinary, "Mirrors binary"),
    requireRegularFile(config.counterInterfaceLockPath, "Counter interface lock"),
    requireRegularFile(config.privateSpecPath, "private spec"),
    ...config.privateTracePaths.map((path) => requireRegularFile(path, "private trace")),
  ]);
  const initialSource = await treeIdentity(config.submissionDirectory);
  if (initialSource.entries.length !== 0) failure("submission directory must be initially empty");
  const policyDocument = JSON.parse(await readFile(config.gatePolicyFile, "utf8"));
  const mountAudit = auditPolicy(policyDocument, config);

  const publicFiles = await loadPublicFiles();
  const publicBundleHash = sha256(canonicalJson(publicFiles));
  const expectedControlUrl = pathToFileURL(resolve(config.gateSdkRoot, "sdk/node/control.mjs")).href;
  const expectedWorkerUrl = pathToFileURL(resolve(config.gateSdkRoot, "sdk/node/index.mjs")).href;
  let resolvedControlUrl;
  let resolvedWorkerUrl;
  try {
    resolvedControlUrl = import.meta.resolve("mirrorgate/control");
    resolvedWorkerUrl = import.meta.resolve("mirrorgate/worker");
  } catch {
    failure("the packed mirrorgate package is not available to normal package resolution");
  }
  if (resolvedControlUrl !== expectedControlUrl || resolvedWorkerUrl !== expectedWorkerUrl) {
    failure("gateSdkRoot does not identify the normally resolved packed mirrorgate package");
  }
  const [clientModule, integrationModule, generatedModule, control, workerSdk] = await Promise.all([
    import("mirrorecma"),
    import("mirrorgate-mirrorecma/legacy"),
    import(pathToFileURL(resolve(config.mirrorEcmaCompiledRoot,
      "test/fixtures/model-interface/counter/generated-async/CounterMirror.generated.js")).href),
    import("mirrorgate/control"),
    import("mirrorgate/worker"),
  ]);
  if (typeof integrationModule.evaluateSandboxed !== "function" ||
      typeof integrationModule.createSandboxCompiledModel !== "function" ||
      typeof generatedModule.bindCounterAsyncPublicPort !== "function" ||
      typeof control.ControlClient !== "function" ||
      typeof workerSdk.createPublicManifest !== "function") {
    failure("packed MirrorECMA, Gate integration, or generated fixture is incompatible");
  }

  const telemetry = new GateTelemetry();
  const restoreControlClient = instrumentControlClient(control.ControlClient, telemetry);
  const lock = JSON.parse(await readFile(config.counterInterfaceLockPath, "utf8"));
  const {
    contract: _contract,
    semanticDigest: _semanticDigest,
    provenance: _provenance,
    provenanceDigest: _provenanceDigest,
    ...descriptorFields
  } = lock;
  const descriptor = clientModule.decodeSemanticDescriptor({
    ...descriptorFields,
    schema: clientModule.MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  });
  const model = integrationModule.createSandboxCompiledModel({
    metadata: generatedModule.CounterModelInterface,
    descriptor,
    adapterId: "counter.generated-async-v1",
    publicManifest: generatedModule.CounterPublicManifest,
    targetProfile: generatedModule.CounterAsyncTargetProfile,
    stateComputerContractVersion: generatedModule.CounterAsyncStateComputerContractVersion,
    bindPublicPort: generatedModule.bindCounterAsyncPublicPort,
    authoringBundle: Object.freeze({ files: publicFiles }),
  });
  let broker;
  let afterSource;
  let authoringGuardPassed = false;
  let sourcePrivatePathStringsAbsent = false;
  const diagnostics = [];
  const probeToken = `BLIND_COUNTER_AUTHORING_GUARD_OK:${sha256(`${Date.now()}:${process.pid}`).slice(0, 24)}\n`;
  let result;
  try {
    result = await integrationModule.evaluateSandboxed({
    gate: {
      kind: "owned",
      launcher: {
        command: config.gateCommand,
        env: { ...process.env },
      },
      policyFile: config.gatePolicyFile,
    },
    policyId: config.gatePolicyId,
    submission: {
      kind: "source",
      input: { rootId: config.submissionRootId, relativePath: config.submissionRelativePath },
      buildPlanId: config.buildPlanId,
      authoring: true,
    },
    runtime: "node-v1",
    model,
    replay: {
      kind: "traces",
      target: config.mirrorBinary,
      config: {
        specPath: config.privateSpecPath,
        invariant: config.invariant,
        constInit: config.constInit,
        lengthBound: config.lengthBound,
        paramVars: "parameters",
      },
      tracePaths: config.privateTracePaths,
    },
    deadlines: {
      registrationMs: config.registrationMs,
      stepMs: config.stepMs,
      receiveMs: config.receiveMs,
    },
    limits: {
      sessionWallMs: config.registrationMs,
      executionWallMs: Math.max(config.stepMs, 1_000),
      stdoutBytes: 256 * 1024,
      stderrBytes: 256 * 1024,
      snapshotFiles: 128,
      snapshotBytes: 16 * 1024 * 1024,
    },
    modelRevisionId: config.modelRevisionId,
    author: async (session) => {
      const probe = await session.exec({
        toolId: "node",
        arguments: ["--input-type=module", "-e",
          trustedProbeSource(config.privateProbePaths, config.privateEnvironmentNames, probeToken)],
        cwd: ".",
      });
      if (probe.exitCode !== 0 || probe.stdout !== probeToken || probe.stderrBytes !== 0 ||
          probe.stdoutTruncated || probe.stderrTruncated) {
        failure("authoring private-boundary canary failed");
      }
      authoringGuardPassed = true;
      broker = new AuthorBroker({
        socketPath: brokerSocket,
        readyFile,
        session,
        initialSource,
        publicBundleHash,
        timeoutMs: config.registrationMs - 5_000,
      });
      await broker.run();
      afterSource = await treeIdentity(config.submissionDirectory);
      sourcePrivatePathStringsAbsent = !(await treeContainsPrivatePathString(
        config.submissionDirectory,
        config.privateProbePaths,
      ));
      if (!sourcePrivatePathStringsAbsent) failure("submitted source contains an evaluator-private path string");
      if (afterSource.entries.length === 0) failure("author submitted an empty source tree");
    },
    disclosure: {},
    }, {
    onDiagnostic: (diagnostic) => {
      diagnostics.push(Object.freeze({
        kind: diagnostic.kind,
        stage: diagnostic.stage,
        family: diagnostic.family,
        summaryHash: sha256(String(diagnostic.summary)),
      }));
    },
    });
  } finally {
    restoreControlClient();
  }

  const prepared = telemetry.prepared;
  const sourceHashMatched = prepared?.sourceHash !== undefined && afterSource?.digest === prepared.sourceHash;
  const buildGuardPassed = telemetry.buildOutput?.stdout.text.includes("BLIND_COUNTER_BUILD_GUARD_OK\n") === true;
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    createdAt: new Date().toISOString(),
    platform: { platform: process.platform, arch: process.arch, node: process.version },
    identities: {
      mirrorEcmaCompiledTree: (await treeIdentity(config.mirrorEcmaCompiledRoot)).digest,
      packedGateSdkTree: (await treeIdentity(config.gateSdkRoot)).digest,
      mirrorBinarySha256: sha256(await readFile(config.mirrorBinary)),
      counterInterfaceLockSha256: sha256(await readFile(config.counterInterfaceLockPath)),
      privateSpecSha256: sha256(await readFile(config.privateSpecPath)),
      privateTraceSha256: await Promise.all(config.privateTracePaths.map(async (path) => sha256(await readFile(path)))),
      publicBundleHash,
      publicManifestDigest: model.publicManifest.interfaceDigest,
      modelRevisionId: config.modelRevisionId,
    },
    source: {
      initial: initialSource,
      afterAuthoring: afterSource,
      gateSourceHash: prepared?.sourceHash,
      sourceHashMatched,
    },
    preparation: prepared === undefined ? undefined : {
      preparedRevision: prepared.preparedRevision,
      artifactId: prepared.artifactId,
      artifactHash: prepared.artifactHash,
      manifestHash: prepared.manifestHash,
      runtime: prepared.runtime,
      policyId: prepared.policyId,
      authoringSeal: telemetry.seal,
    },
    guards: {
      authoring: authoringGuardPassed ? "passed" : "failed",
      build: buildGuardPassed ? "passed" : "failed",
      execution: result.status === "passed" ? "passed-by-createAdapter-guard" : "not-established",
      privatePathStringsAbsentFromPolicy: true,
      privatePathStringsAbsentFromSubmittedSource: sourcePrivatePathStringsAbsent,
    },
    mountAudit,
    broker: {
      protocol: BROKER_PROTOCOL,
      tools: [...PUBLIC_TOOLS.keys()],
      transcript: broker?.transcript ?? [],
    },
    gateEvents: Object.fromEntries([...telemetry.events.entries()].sort()),
    diagnostics,
    result,
    cleanup: telemetry.cleanup,
  };
  await mkdir(dirname(config.evidencePath), { recursive: true, mode: 0o700 });
  await writeFile(config.evidencePath, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

  const accepted = result.status === "passed" && result.cleanup === "confirmed" && sourceHashMatched &&
    authoringGuardPassed && buildGuardPassed && sourcePrivatePathStringsAbsent &&
    telemetry.seal?.status === "failed" && telemetry.seal?.code === "STATE_INVALID";
  process.stdout.write(`${JSON.stringify({
    event: "evaluation.finished",
    accepted,
    result,
    evidenceSha256: sha256(await readFile(config.evidencePath)),
  })}\n`);
  if (!accepted) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "/")).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "blind Counter evaluator failed"}\n`);
    process.exitCode = 1;
  });
}
