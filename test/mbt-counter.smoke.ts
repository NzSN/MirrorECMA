import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  ReplayMismatchError,
  connectTlsMirror,
  semanticDigestFromHex,
  type AsyncAdapterFactory,
  type CompiledReplayReport,
  type ReplayContext,
} from "../src/index.js";
import { createLocalCounterFactory } from "../examples/mbt-counter/local-provider.js";
import { counterReplayInputs, runCounterSuite } from "../examples/mbt-counter/suite.js";
import {
  bindCounterAsyncPublicPort,
  CounterSemanticDigest,
} from "./fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";

// This worker receives public operations only. It is a transport demonstration,
// not a security sandbox, and never receives the generated binding/model/trace.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
let count = 0n;
parentPort.on("message", ({ id, operationId, inputs }) => {
  try {
    let value;
    if (operationId === "Initialize") count = 0n;
    else if (operationId === "Tick") count += inputs.Stride - (workerData.broken ? 1n : 0n);
    else if (operationId === "observe") value = { Count: count };
    else throw new Error("unknown public operation");
    parentPort.postMessage({ id, value });
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
`;

function proxyFactory(broken: boolean) {
  const calls: { operationId: string; inputs: Readonly<Record<string, unknown>> }[] = [];
  let creations = 0;
  let disposals = 0;
  const factory: AsyncAdapterFactory = async (config, authority) => {
    assert.equal(authority.status, "matched");
    creations++;
    const worker = new Worker(workerSource, { eval: true, workerData: { broken } });
    let nextId = 0;
    let terminal: Error | undefined;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
    const fail = (error: Error): void => {
      terminal = error;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", () => fail(new Error("public-port worker exited")));
    worker.on("message", (reply: { id: number; value?: unknown; error?: string }) => {
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id);
      if (reply.error) request.reject(new Error(reply.error));
      else request.resolve(reply.value);
    });
    const request = (operationId: string, inputs: Readonly<Record<string, unknown>>, context: ReplayContext): Promise<unknown> => {
      if (terminal) return Promise.reject(terminal);
      if (context.signal.aborted) return Promise.reject(context.signal.reason);
      const id = nextId++;
      calls.push({ operationId, inputs: structuredClone(inputs) });
      return new Promise((resolveReply, reject) => {
        const onAbort = () => finish(() => reject(new Error("public-port request cancelled")));
        const timer = setTimeout(() => finish(() => reject(new Error("public-port request expired"))),
          Math.max(1, Math.ceil(context.deadline - performance.now())));
        const finish = (action: () => void): void => {
          pending.delete(id);
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
          action();
        };
        pending.set(id, {
          resolve: (value) => finish(() => resolveReply(value)),
          reject: (error) => finish(() => reject(error)),
        });
        context.signal.addEventListener("abort", onAbort, { once: true });
        try { worker.postMessage({ id, operationId, inputs }); }
        catch (error) { finish(() => reject(error)); }
      });
    };
    const binding = bindCounterAsyncPublicPort({
      invoke: async (operationId, inputs, context) => { await request(operationId, inputs, context); },
      observe: async (context) => {
        const value = await request("observe", {}, context);
        assert.ok(value && typeof value === "object" && "Count" in value);
        return { Count: value.Count };
      },
    }, config);
    return {
      ...binding, semanticDigest: semanticDigestFromHex(CounterSemanticDigest),
      dispose: async () => { disposals++; await worker.terminate(); },
    };
  };
  return { factory, calls, counts: () => ({ creations, disposals }) };
}

async function mismatch(run: Promise<CompiledReplayReport>): Promise<ReturnType<ReplayMismatchError["toJSON"]>> {
  try { await run; } catch (error) {
    assert.ok(error instanceof ReplayMismatchError);
    return error.toJSON();
  }
  throw new Error("faulty implementation unexpectedly passed");
}

function runNode(args: string[], env: NodeJS.ProcessEnv, command = process.execPath, cwd = process.cwd()): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (status) => { clearTimeout(timeout); resolveResult({ status, stdout, stderr }); });
  });
}

async function checkSharedServer(binary: string, expected: CompiledReplayReport): Promise<void> {
  const certs = await mkdtemp(join(tmpdir(), "counter-suite-tls-"));
  try { await checkSharedTlsServer(binary, expected, certs); }
  finally { await rm(certs, { recursive: true, force: true }); }
}

async function checkSharedTlsServer(binary: string, expected: CompiledReplayReport, certs: string): Promise<void> {
  const openssl = async (args: string[]): Promise<void> => {
    const result = await runNode(args, process.env, "openssl", certs);
    assert.equal(result.status, 0, result.stderr);
  };
  await openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key",
    "-out", "ca.crt", "-days", "1", "-subj", "/CN=Counter Suite Test CA"]);
  for (const role of ["server", "client"]) {
    await writeFile(join(certs, `${role}.ext`), "basicConstraints=CA:FALSE\n" +
      "keyUsage=digitalSignature,keyEncipherment\n" +
      `extendedKeyUsage=${role}Auth\n` + (role === "server" ? "subjectAltName=IP:127.0.0.1,DNS:localhost\n" : ""));
    await openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${role}.key`,
      "-out", `${role}.csr`, "-subj", `/CN=counter-${role}`]);
    await openssl(["x509", "-req", "-in", `${role}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key",
      "-CAcreateserial", "-out", `${role}.crt`, "-days", "1", "-extfile", `${role}.ext`]);
    await chmod(join(certs, `${role}.key`), 0o600);
  }
  const fingerprint = new X509Certificate(await readFile(join(certs, "client.crt")))
    .fingerprint256.replaceAll(":", "").toLowerCase();
  const reservation = createServer();
  await new Promise<void>((resolveReady, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolveReady);
  });
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClosed, reject) => reservation.close((error) => error ? reject(error) : resolveClosed()));
  const server = spawn(binary, ["--server", String(port), "--tls", "--bind", "127.0.0.1",
    "--cert", join(certs, "server.crt"), "--key", join(certs, "server.key"), "--ca", join(certs, "ca.crt"),
    "--model-interface-allow-client", fingerprint], { stdio: "ignore" });
  const connect = () => connectTlsMirror("127.0.0.1", port, {
    caPath: join(certs, "ca.crt"), certPath: join(certs, "client.crt"), keyPath: join(certs, "client.key"),
  });
  let spawnError: Error | undefined;
  server.once("error", (error) => { spawnError = error; });
  const closed = new Promise<void>((resolveClosed) => server.once("close", () => resolveClosed()));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt++) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw new Error("shared Mirrors server exited before readiness");
      try { const probe = await connect(); await probe.close(); ready = true; }
      catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
    }
    assert.ok(ready, "shared Mirrors server did not become ready");
    for (let run = 0; run < 2; run++) {
      const result = await runCounterSuite({
        ...counterReplayInputs(process.cwd()), mirror: await connect(),
      }, createLocalCounterFactory());
      assert.deepEqual(result, expected);
      assert.equal(server.exitCode, null, "closing an evaluation connection must leave the server running");
    }
  } finally {
    server.kill("SIGKILL");
    await closed;
  }
}

async function main(): Promise<void> {
  const mirror = process.env.MIRROR_BIN;
  assert.ok(mirror, "MIRROR_BIN is required; this gate must exercise real Mirrors replay");
  const context = { mirror: resolve(mirror), ...counterReplayInputs(process.cwd()) };
  const cli = resolve("dist-test/examples/mbt-counter/run.js");
  const childEnv = { ...process.env, MIRROR_BIN: context.mirror };
  const correct = await runCounterSuite(context, createLocalCounterFactory());
  const faulty = await mismatch(runCounterSuite(context, createLocalCounterFactory(true)));
  for (const broken of [false, true]) {
    const proxy = proxyFactory(broken);
    const run = runCounterSuite(context, proxy.factory);
    if (broken) assert.deepEqual(await mismatch(run), faulty);
    else assert.deepEqual(await run, correct);
    assert.deepEqual(proxy.counts(), { creations: 1, disposals: 1 });
    assert.deepEqual(proxy.calls.map(({ operationId }) => operationId), broken
      ? ["Initialize", "observe", "Tick", "observe"]
      : ["Initialize", "observe", "Tick", "observe", "Tick", "observe"]);
    for (const call of proxy.calls) {
      assert.deepEqual(Object.keys(call.inputs), call.operationId === "Tick" ? ["Stride"] : []);
    }
    const result = await runNode([cli, ...(broken ? ["--broken"] : [])], childEnv);
    assert.equal(result.status, broken ? 1 : 0, result.stderr);
    assert.deepEqual(JSON.parse((broken ? result.stderr : result.stdout).trim()),
      JSON.parse(JSON.stringify(broken ? faulty : correct)));
  }
  const sourceTests = await runNode(
    ["--experimental-vm-modules", "node_modules/jest/bin/jest.js", "--runInBand", "test/mbt-counter.test.ts"],
    childEnv);
  assert.equal(sourceTests.status, 0, sourceTests.stdout + sourceTests.stderr);
  await checkSharedServer(context.mirror, correct);
  console.log(sourceTests.stderr.trim());
  console.log("Counter MBT: source tests, CLI and worker proxy agree for correct/faulty implementations; real Mirrors replay passed.");
  console.log("Proxy evidence establishes public-port projection and disposal, not sandbox isolation or an evaluation service.");
  console.log("Two authorized mTLS evaluation connections passed against one server; both connection closures left it running.");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
