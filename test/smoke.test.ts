import {
  runClient,
  runClientWithTraces,
  runClientGenTraces,
  presetClient,
  type ApalacheConfig,
  type TraceGenerationConfig,
  type StateComputer,
  type State,
  asInt,
  getParam,
} from "../src/index.js";

import { resolve } from "node:path";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createHash } from "node:crypto";
import { X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { discoverServices } from "../src/index.js";

let BIN = process.env.MIRROR_BIN ?? "";
if (BIN && process.env.RUNFILES && !/^\//.test(BIN)) {
  BIN = resolve(process.env.RUNFILES, BIN);
}
if (!BIN) {
  console.error("MIRROR_BIN not set");
  process.exit(1);
}

const SPEC = process.env.SPEC ?? "./specs/Counter.tla";

const apalacheConfig: ApalacheConfig = {
  specPath: SPEC,
  invariant: "TraceComplete",
  lengthBound: 6,
  constInit: "CInit",
  paramVars: "parameters",
};

const traceConfig: TraceGenerationConfig = {
  numTraces: 100,
  view: "View"
};

class Counter {
  count: bigint;

  constructor() {
    this.count = 0n;
  }

  tick(stride: bigint): void {
    this.count += stride;
  }

  toState(): State {
    return {
      count: { tag: "int", val: this.count },
    };
  }
}

class CounterComputer {
  private counter = new Counter();

  compute(action: string, params: State, prevState: State): State {
    if (action === "Init" || !prevState.count) {
      this.counter = new Counter();
      return this.counter.toState();
    }

    const rec = getParam(params, "parameters");
    const stride = rec ? asInt(rec.stride!) ?? 0n : 0n;

    this.counter.tick(stride);
    return this.counter.toState();
  }
}

async function testRegister() {
  const computer = new CounterComputer();
  console.log(`Running smoke test (register) with spec: ${SPEC}`);
  await runClient(BIN, apalacheConfig, traceConfig, computer.compute.bind(computer));
  console.log("OK: register smoke test passed");
}

async function testRegisterTraces() {
  let tracePath = "specs/traces/violation.itf.json";
  if (process.env.RUNFILES) {
    tracePath = resolve(process.env.RUNFILES, "_main", tracePath);
  } else {
    tracePath = resolve(tracePath);
  }
  const states: State[] = [
    { count: { tag: "int", val: 0n } },
    { count: { tag: "int", val: 2n } },
    { count: { tag: "int", val: 4n } },
    { count: { tag: "int", val: 6n } },
    { count: { tag: "int", val: 8n } },
    { count: { tag: "int", val: 10n } },
    { count: { tag: "int", val: 13n } },
  ];

  console.log("Running smoke test (register_traces)");
  await runClientWithTraces(BIN, apalacheConfig, [tracePath], presetClient(states));
  console.log("OK: register_traces smoke test passed");
}

async function testRegisterGenTraces() {
  const destDir = await mkdtemp(tmpdir() + "/mirrorecma-gen-");
  console.log(`Running smoke test (register_trace_gen) with spec: ${SPEC}, dest: ${destDir}`);
  await runClientGenTraces(BIN, apalacheConfig, destDir, traceConfig);
  const files = await readdir(destDir);
  const traceFiles = files.filter(f => f.endsWith(".itf.json"));
  if (traceFiles.length === 0) throw new Error("no trace files generated");
  console.log(`OK: register_trace_gen smoke test passed (${traceFiles.length} traces)`);
}

const execFileAsync = promisify(execFile);
const GEN_CERTS = fileURLToPath(
  new URL("../scripts/gen-test-certs.sh", import.meta.url)
);

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const addr = srv.address();
  if (addr === null || typeof addr === "string") throw new Error("no addr");
  await new Promise((res) => srv.close(res));
  return addr.port;
}

async function withConnectRetry<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (Date.now() > deadline || !/ECONNREFUSED/.test(msg)) throw err;
      await new Promise((res) => setTimeout(res, 250));
    }
  }
}

function spawnServer(args: string[]): ChildProcess {
  const child = spawn(BIN, args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (err) => { throw err; });
  return child;
}

async function testTcpServer() {
  const port = await freePort();
  console.log(`Running smoke test (tcp --serve) on 127.0.0.1:${port}`);
  const server = spawnServer(["--serve", String(port)]);
  try {
    const computer = new CounterComputer();
    await withConnectRetry(
      () =>
        runClient(
          { server: { host: "127.0.0.1", port } },
          apalacheConfig,
          traceConfig,
          computer.compute.bind(computer)
        ),
      15000
    );
  } finally {
    server.kill();
  }
  console.log("OK: tcp smoke test passed");
}

interface TestCerts {
  dir: string;
  ca: Buffer;
  serverFingerprint: string;
  clientCert: Buffer;
  clientKey: Buffer;
}

async function genCerts(): Promise<TestCerts> {
  const dir = await mkdtemp(tmpdir() + "/mirrorecma-smoke-certs-");
  await execFileAsync(GEN_CERTS, [dir]);
  const ca = await readFile(resolve(dir, "ca.crt"));
  const serverCrt = await readFile(resolve(dir, "server.crt"));
  const clientCert = await readFile(resolve(dir, "client.crt"));
  const clientKey = await readFile(resolve(dir, "client.key"));
  const serverFingerprint = createHash("sha256")
    .update(new X509Certificate(serverCrt).raw)
    .digest("hex");
  return { dir, ca, serverFingerprint, clientCert, clientKey };
}

function tlsServerArgs(port: number, certs: TestCerts): string[] {
  return [
    "--server", String(port), "--tls",
    "--cert", resolve(certs.dir, "server.crt"),
    "--key", resolve(certs.dir, "server.key"),
    "--ca", resolve(certs.dir, "ca.crt"),
  ];
}

async function testTlsServer() {
  const certs = await genCerts();
  const port = await freePort();
  console.log(`Running smoke test (mtls --server --tls) on 127.0.0.1:${port}`);
  const server = spawnServer(tlsServerArgs(port, certs));
  try {
    const computer = new CounterComputer();
    await withConnectRetry(
      () =>
        runClient(
          {
            server: {
              host: "127.0.0.1",
              port,
              ca: certs.ca,
              cert: certs.clientCert,
              key: certs.clientKey,
              servername: "127.0.0.1",
              certSha256: certs.serverFingerprint,
            },
          },
          apalacheConfig,
          traceConfig,
          computer.compute.bind(computer)
        ),
      15000
    );
  } finally {
    server.kill();
  }
  console.log("OK: mtls smoke test passed");
}

async function testRegistryDiscovery() {
  const registry = process.env.MODELMIRRORS_REGISTRY;
  if (!registry) {
    console.log("SKIP: registry smoke test (MODELMIRRORS_REGISTRY not set)");
    return;
  }
  await registryDiscoveryAgainst(registry);
}

interface FakeConsulService {
  id: string;
  address: string;
  port: number;
  meta: Record<string, string>;
  passing: boolean;
}

async function startFakeConsul(): Promise<{ url: string; close: () => Promise<void> }> {
  const services = new Map<string, FakeConsulService>();
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "PUT" && url.pathname === "/v1/agent/service/register") {
        const svc = JSON.parse(body);
        services.set(svc.ID, {
          id: svc.ID,
          address: svc.Address,
          port: svc.Port,
          meta: svc.Meta ?? {},
          passing: false,
        });
        res.writeHead(200).end();
      } else if (req.method === "PUT" && url.pathname.startsWith("/v1/agent/check/pass/service:")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/agent/check/pass/service:".length));
        const svc = services.get(id);
        if (svc) svc.passing = true;
        res.writeHead(200).end();
      } else if (req.method === "PUT" && url.pathname.startsWith("/v1/agent/service/deregister/")) {
        services.delete(decodeURIComponent(url.pathname.slice("/v1/agent/service/deregister/".length)));
        res.writeHead(200).end();
      } else if (req.method === "GET" && url.pathname.startsWith("/v1/health/service/")) {
        const passingOnly = url.searchParams.get("passing") === "true";
        const out = [...services.values()]
          .filter((s) => !passingOnly || s.passing)
          .map((s) => ({
            Node: { Address: s.address },
            Service: { ID: s.id, Service: "modelmirrors", Address: s.address, Port: s.port, Meta: s.meta },
          }));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no addr");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((res) => server.close(() => res())),
  };
}

async function testRegistryDiscoveryFake() {
  const consul = await startFakeConsul();
  console.log(`Running smoke test (registry discovery, fake consul) via ${consul.url}`);
  try {
    await registryDiscoveryAgainst(consul.url);
  } finally {
    await consul.close();
  }
  console.log("OK: registry discovery (fake consul) smoke test passed");
}

async function registryDiscoveryAgainst(registry: string) {
  const certs = await genCerts();
  const port = await freePort();
  const server = spawnServer([...tlsServerArgs(port, certs), "--registry", registry]);
  try {
    const deadline = Date.now() + 30000;
    let found = false;
    while (Date.now() < deadline) {
      const services = await discoverServices(registry);
      if (services.some((s) => s.port === port)) { found = true; break; }
      await new Promise((res) => setTimeout(res, 1000));
    }
    if (!found) throw new Error("server did not appear in registry within 30s");
    const computer = new CounterComputer();
    await withConnectRetry(
      () =>
        runClient(
          {
            registry,
            tls: {
              ca: certs.ca,
              cert: certs.clientCert,
              key: certs.clientKey,
              servername: "127.0.0.1",
            },
          },
          apalacheConfig,
          traceConfig,
          computer.compute.bind(computer)
        ),
      15000
    );
  } finally {
    server.kill();
  }
  console.log("OK: registry discovery smoke test passed");
}

async function main() {
  await testRegister();
  await testRegisterTraces();
  await testRegisterGenTraces();
  await testTcpServer();
  await testTlsServer();
  await testRegistryDiscoveryFake();
  await testRegistryDiscovery();
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
