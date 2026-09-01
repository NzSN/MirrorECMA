import {
  runClient,
  runClientWithTraces,
  runClientGenTraces,
  runClientExplore,
  startExploreSession,
  specFromFile,
  specFromFiles,
  presetClient,
  Connection,
  runClientValidate,
  JobQueueFullError,
  type ApalacheConfig,
  type ApalacheSpec,
  type TraceGenerationConfig,
  type StateComputer,
  type State,
  asInt,
  getParam,
} from "../src/index.js";

import { resolve } from "node:path";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { X509Certificate } from "node:crypto";
import {
  connectMirror,
  connectTlsMirror,
  sha256Hex,
  type TlsConnectTransport,
  type TlsOptions,
  type Transport,
} from "../src/transport.js";
import { connectMirrorFromRegistry } from "../src/registry.js";

// Node 24 warns (DEP0123) that setting an SNI servername to an IP literal is
// not permitted by RFC 6066. connectTlsMirror defaults servername to the host
// ("127.0.0.1" here); the warning is benign — hostname/IP-SAN validation still
// runs against the connect host — but would spam the smoke output.
process.noDeprecation = true;

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

class IncorrectCounterComputer extends CounterComputer {
  override compute(action: string, params: State, prevState: State): State {
    return {
      ...super.compute(action, params, prevState),
      unexpected: { tag: "bool", val: true },
    };
  }
}

async function testRegister(target: string | Transport = BIN) {
  const computer = new CounterComputer();
  console.log(`Running smoke test (register) with spec: ${SPEC}`);
  await runClient(target, apalacheConfig, traceConfig, computer.compute.bind(computer));
  console.log("OK: register smoke test passed");
}

async function testRegisterMismatch(target: string | Transport = BIN) {
  const computer = new IncorrectCounterComputer();
  let mismatch = false;
  try {
    await runClient(target, apalacheConfig, traceConfig, computer.compute.bind(computer));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/step mismatch/.test(message) || !/unexpected/.test(message)) throw error;
    mismatch = true;
  }
  if (!mismatch) throw new Error("incorrect Counter state unexpectedly passed replay");
  console.log("OK: extra observable state key produces terminal step_mismatch");
}

async function testRegisterTraces(target: string | Transport = BIN) {
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
  await runClientWithTraces(target, apalacheConfig, [tracePath], presetClient(states));
  console.log("OK: register_traces smoke test passed");
}

async function testRegisterGenTraces(target: string | Transport = BIN) {
  const destDir = await mkdtemp(tmpdir() + "/mirrorecma-gen-");
  console.log(`Running smoke test (register_trace_gen) with spec: ${SPEC}, dest: ${destDir}`);
  const result = await runClientGenTraces(target, apalacheConfig, destDir, traceConfig);
  const files = await readdir(destDir);
  const traceFiles = files.filter(f => f.endsWith(".itf.json"));
  if (traceFiles.length === 0) throw new Error("no trace files generated");
  if (result.itfTracePaths.length !== traceFiles.length)
    throw new Error(`expected ${traceFiles.length} paths, got ${result.itfTracePaths.length}`);
  if (result.itfTraces.length !== result.itfTracePaths.length)
    throw new Error(`expected ${result.itfTracePaths.length} inline traces, got ${result.itfTraces.length}`);
  for (const tr of result.itfTraces) {
    const states = (tr as { states?: unknown[] }).states;
    if (!Array.isArray(states) || states.length === 0)
      throw new Error("inline trace has no states");
  }
  console.log(`OK: register_trace_gen smoke test passed (${traceFiles.length} traces, inlined)`);
}

function hourClockSpecPath(): string {
  const p = "specs/HourClock.tla";
  return process.env.RUNFILES ? resolve(process.env.RUNFILES, "_main", p) : resolve(p);
}

// Faithful HourClock implementation: reports all 6 state vars, including
// action_taken — the mirror derives the action name from it and
// conformance-checks the full reported state.
// Note: mainLoop passes the received state as `params` for initial_state
// (prevState is {}), so init echoes params.
class HourClockComputer {
  compute(action: string, params: State, prevState: State): State {
    void action;
    if (!prevState.hr) return params;

    const oldHr = asInt(prevState.hr!) ?? 0n;
    const oldStep = asInt(prevState.step_count!) ?? 0n;
    return {
      hr: { tag: "int", val: oldHr !== 12n ? oldHr + 1n : 1n },
      latest_hr: { tag: "int", val: oldHr },
      ticked: { tag: "bool", val: true },
      action_taken: { tag: "str", val: "tick" },
      nondet_picks: prevState.nondet_picks!,
      step_count: { tag: "int", val: oldStep + 1n },
    };
  }
}

async function testExplore(target: string | Transport = BIN) {
  const spec = await specFromFile(hourClockSpecPath());
  console.log("Running smoke test (register_explore)");
  const computer = new HourClockComputer();
  await runClientExplore(target, spec, ["Inv"], [], 4, computer.compute.bind(computer));
  console.log("OK: register_explore smoke test passed");
}

async function testExploreSession(target: string | Transport = BIN) {  const spec = await specFromFile(hourClockSpecPath());
  console.log("Running smoke test (register_explore_session)");
  const session = await startExploreSession(target, spec, ["Inv"], []);

  const { initTransitions, nextTransitions, stateInvariants } = session.ready;
  if (initTransitions !== 1) throw new Error(`expected 1 init transition, got ${initTransitions}`);
  if (nextTransitions < 1) throw new Error(`expected >= 1 next transition, got ${nextTransitions}`);
  if (stateInvariants !== 1) throw new Error(`expected 1 state invariant, got ${stateInvariants}`);

  const status1 = await session.assumeTransition(0);
  if (status1 !== "ENABLED") throw new Error(`assumeTransition: expected ENABLED, got ${status1}`);

  const stepNo = await session.nextStep();
  if (stepNo !== 1) throw new Error(`nextStep: expected step 1, got ${stepNo}`);

  const state = await session.queryState();
  const hr = state.hr;
  if (!hr) throw new Error("queryState: state has no hr");

  const invStatus = await session.checkInvariant(0);
  if (invStatus !== "SATISFIED") throw new Error(`checkInvariant: expected SATISFIED, got ${invStatus}`);

  const status2 = await session.assumeState({ hr });
  if (status2 !== "ENABLED") throw new Error(`assumeState: expected ENABLED, got ${status2}`);

  const snap = await session.rollback(0);
  if (snap !== 0) throw new Error(`rollback: expected snapshot 0, got ${snap}`);

  await session.done();
  console.log("OK: register_explore_session smoke test passed");
}

// Faithful ExtMain implementation (2-module spec: ExtMain EXTENDS ExtDep).
// Full state = { count, action_taken }; init echoes the received state
// (mainLoop passes it as `params`), tick increments.
class ExtCounterComputer {
  compute(action: string, params: State, prevState: State): State {
    void action;
    if (!prevState.count) return params;
    return {
      count: { tag: "int", val: (asInt(prevState.count!) ?? 0n) + 1n },
      action_taken: { tag: "str", val: "tick" },
    };
  }
}

async function testRegisterInlineSpec(target: string | Transport = BIN) {
  const specDir = process.env.RUNFILES
    ? resolve(process.env.RUNFILES, "_main", "specs")
    : resolve("specs");
  const spec = await specFromFiles(resolve(specDir, "ExtMain.tla"));
  console.log(`Running smoke test (register with inline spec, ${spec.sources.length} modules)`);
  // specPath deliberately bogus: the mirror must use the inline sources.
  const cfg: ApalacheConfig = {
    specPath: "/nonexistent/ExtMain.tla",
    invariant: "TraceComplete",
    lengthBound: 3,
  };
  const computer = new ExtCounterComputer();
  await runClient(target, cfg, { numTraces: 1 }, computer.compute.bind(computer), { spec });
  console.log("OK: register with inline spec smoke test passed");
}

// Spawn the mirror as a TCP daemon (`--serve <port>`), wait until it accepts
// connections, run every scenario over fresh connections, then kill the
// daemon. The daemon serves the connections sequentially via its accept loop.
function tcpTarget(port: number): Transport {
  return connectMirror("127.0.0.1", port);
}

async function testOverTcp() {
  const port = 10000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn(BIN, ["--serve", String(port)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  try {
    let connected = false;
    for (let i = 0; i < 50 && !connected; i++) {
      try {
        const probe = connectMirror("127.0.0.1", port);
        await probe.ready;
        await probe.close();
        connected = true;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!connected) throw new Error("mirror daemon did not start listening");

    console.log("Running smoke tests over TCP");
    await testRegister(tcpTarget(port));
    await testRegisterMismatch(tcpTarget(port));
    await testRegisterTraces(tcpTarget(port));
    await testRegisterGenTraces(tcpTarget(port));
    await testExplore(tcpTarget(port));
    await testExploreSession(tcpTarget(port));
    await testRegisterInlineSpec(tcpTarget(port));
    console.log("OK: all TCP smoke tests passed");
  } finally {
    child.kill();
  }
}

// ---------------------------------------------------------------------------
// Async jobs + synchronous validate (P2; client guide section 6, C16-C23)
// ---------------------------------------------------------------------------

// Self-contained inline spec for the validate/async scenarios: no server
// filesystem dependency (C13). InvOk holds for every reachable state,
// InvBad is violated in the initial state.
const ASYNC_CLOCK_SRC = `---- MODULE AsyncClock ----
EXTENDS Integers
VARIABLE
  \\* @type: Int;
  h

Init == h = 1

Next == h' = h + 1

\\* @type: () => Bool;
InvOk == h >= 1

\\* @type: () => Bool;
InvBad == h < 1
====
`;
const asyncClockSpec: ApalacheSpec = { sources: [ASYNC_CLOCK_SRC] };

function asyncClockConfig(invariant: string): ApalacheConfig {
  return {
    // With inline sources the specPath is the module's basename inside
    // the mirror's materialized temp dir (guide section 5).
    specPath: "AsyncClock.tla",
    invariant,
    lengthBound: 5,
  };
}

// Slow validate job: apalache checks Counter out to bound 100 — long
// enough that an immediate cancel always wins the race. Counter declares
// CONSTANTS, so constInit is required (C15).
function slowValidateConfig(): { cfg: ApalacheConfig; bound: number } {
  return {
    cfg: {
      specPath: SPEC,
      invariant: "TraceComplete",
      lengthBound: 10,
      constInit: "CInit",
    },
    bound: 100,
  };
}

async function waitForTcpDaemon(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const probe = connectMirror("127.0.0.1", port);
      await probe.ready;
      await probe.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("mirror daemon did not start listening");
}

async function testValidateAndAsyncTcp() {
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child: ChildProcess = spawn(BIN, ["--serve", String(port), "--jobs", "2"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  try {
    await waitForTcpDaemon(port);
    console.log("Running validate + async job smoke tests (TCP, --jobs 2)");

    // 1. Synchronous validate, valid + invalid (C16).
    const valid = await runClientValidate(tcpTarget(port), asyncClockConfig("InvOk"), 5, {
      spec: asyncClockSpec,
    });
    if (valid !== "valid") throw new Error(`expected valid, got ${JSON.stringify(valid)}`);
    const invalid = await runClientValidate(tcpTarget(port), asyncClockConfig("InvBad"), 5, {
      spec: asyncClockSpec,
    });
    if (typeof invalid === "string") throw new Error("expected an invalid validate result");
    console.log("OK: sync validate (valid + invalid)");

    // 2. Async validate: submit + await; the outcome payload must equal
    //    the synchronous reply for the same config (C20 congruence).
    const connA = await Connection.open(tcpTarget(port));
    const handle = await connA.submitValidateAsync(asyncClockConfig("InvOk"), 5, {
      spec: asyncClockSpec,
    });
    if (handle.kind !== "validate") throw new Error(`unexpected job kind ${handle.kind}`);
    const awaited = await handle.await(60);
    if (!awaited.done) throw new Error("validate job did not terminate within 60s");
    if (!("validate" in awaited.result.outcome))
      throw new Error(`expected a validate outcome: ${JSON.stringify(awaited.result.outcome)}`);
    if (awaited.result.outcome.validate !== valid)
      throw new Error(
        `C20 mismatch: sync ${JSON.stringify(valid)} != async ${JSON.stringify(awaited.result.outcome.validate)}`,
      );
    console.log("OK: async validate awaits and matches the sync reply (C20)");

    // 3. Cross-connection: submit on A, await on B (C17).
    const connB = await Connection.open(tcpTarget(port));
    const handleX = await connA.submitValidateAsync(asyncClockConfig("InvOk"), 5, {
      spec: asyncClockSpec,
    });
    const awaitedX = await connB.awaitJob(handleX.jobId, 60);
    if (!awaitedX.done || !("validate" in awaitedX.result.outcome))
      throw new Error("cross-connection await did not return the job outcome");
    if (awaitedX.result.outcome.validate !== "valid")
      throw new Error("cross-connection await returned the wrong outcome");
    console.log("OK: submit on one connection, await on another (C17)");

    // C23: results are correlated by job id, not submission/completion
    // order. Submit valid then invalid and deliberately await in reverse.
    const orderedValid = await connA.submitValidateAsync(asyncClockConfig("InvOk"), 5, {
      spec: asyncClockSpec,
    });
    const orderedInvalid = await connA.submitValidateAsync(asyncClockConfig("InvBad"), 5, {
      spec: asyncClockSpec,
    });
    const invalidFirst = await connB.awaitJob(orderedInvalid.jobId, 60);
    if (
      !invalidFirst.done ||
      !("validate" in invalidFirst.result.outcome) ||
      typeof invalidFirst.result.outcome.validate === "string"
    ) throw new Error("reverse-order invalid job did not retain its own outcome");
    const validSecond = await connB.awaitJob(orderedValid.jobId, 60);
    if (
      !validSecond.done ||
      !("validate" in validSecond.result.outcome) ||
      validSecond.result.outcome.validate !== "valid"
    ) throw new Error("reverse-order valid job did not retain its own outcome");
    console.log("OK: async results remain correlated under reverse awaits (C23)");

    // Liveness probe on an idle connection (C7 MAY).
    if (!(await connB.ping())) throw new Error("ping failed against a live server");

    // 4. trace_gen_async with destPath omitted: the outcome carries
    //    server-temp paths plus inline trace contents. (numTraces > 1
    //    needs a view on the apalache side, like the sync gen test.)
    const genHandle = await connA.submitTraceGenAsync(apalacheConfig, {
      numTraces: 2,
      view: "View",
    });
    const genDone = await connB.awaitJob(genHandle.jobId, 120);
    if (!genDone.done) throw new Error("trace gen job did not terminate within 120s");
    if (!("genTraces" in genDone.result.outcome))
      throw new Error(`expected a genTraces outcome: ${JSON.stringify(genDone.result.outcome)}`);
    const gt = genDone.result.outcome.genTraces;
    // numTraces maps to apalache's max-error, not an exact trace count
    // (the sync gen test asks for 100 and gets 38); assert the sync
    // test's discipline instead: paths ≡ inline traces, non-empty.
    if (gt.itfTracePaths.length === 0 || gt.itfTracePaths.length !== gt.itfTraces.length)
      throw new Error(
        `paths/inline-traces mismatch: ${gt.itfTracePaths.length} + ${gt.itfTraces.length}`,
      );
    for (const tr of gt.itfTraces) {
      const states = (tr as { states?: unknown[] }).states;
      if (!Array.isArray(states) || states.length === 0)
        throw new Error("inline trace has no states");
    }
    console.log("OK: trace gen async returns inline traces");

    // 5. Cancel (C19): cooperative cancellation kills the apalache
    //    child; the reply is the post-cancel job_status and a later
    //    await yields the terminal cancelled outcome.
    const slow = slowValidateConfig();
    const slowHandle = await connA.submitValidateAsync(slow.cfg, slow.bound);
    const cancelReply = await slowHandle.cancel();
    if (cancelReply.proto_step !== "job_status" || cancelReply.phase !== "cancelled")
      throw new Error(`unexpected cancel reply: ${JSON.stringify(cancelReply)}`);
    const afterCancel = await slowHandle.await(30);
    if (!afterCancel.done) throw new Error("cancelled job never went terminal");
    const cancelOutcome = afterCancel.result.outcome;
    if (!("error" in cancelOutcome) || !/cancelled/.test(cancelOutcome.error))
      throw new Error(`expected a cancelled outcome: ${JSON.stringify(cancelOutcome)}`);
    console.log("OK: cancel_job cancels and the outcome is terminal (C19)");

    // connA is done; close it BEFORE opening connC. The daemon runs
    // --jobs 2 (two connection workers), so at most two connections may
    // be open at once — a third queues at the accept backlog and is
    // never served (pool sizing discipline, C22).
    await connA.close();

    // 6. C6/C21: closing the submitting connection cancels AND evicts
    //    its jobs; another connection then observes phase "unknown".
    const connC = await Connection.open(tcpTarget(port));
    const doomedCfg = slowValidateConfig();
    const doomed = await connC.submitValidateAsync(doomedCfg.cfg, doomedCfg.bound);
    await connC.close();
    let lastSeen = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const q = await connB.queryJob(doomed.jobId);
      if (q.proto_step === "job_status") {
        lastSeen = q.phase;
        if (q.phase === "unknown") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (lastSeen !== "unknown")
      throw new Error(`expected the disconnected job to be evicted to unknown, got ${lastSeen}`);
    console.log("OK: disconnect cancels and evicts the session's jobs (C6/C21)");

    await connB.close();
    console.log("OK: all validate + async job smoke tests passed");
  } finally {
    child.kill();
  }
}

// C22: with --jobs 1 the store holds exactly one live job; a second
// submit is rejected synchronously with register_error ("job queue full").
async function testQueueFull() {
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child: ChildProcess = spawn(BIN, ["--serve", String(port), "--jobs", "1"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  try {
    await waitForTcpDaemon(port);
    console.log("Running queue-full smoke test (TCP, --jobs 1)");
    const conn = await Connection.open(tcpTarget(port));
    const slow = slowValidateConfig();
    const first = await conn.submitValidateAsync(slow.cfg, slow.bound);
    let fullErr: unknown = null;
    try {
      await conn.submitValidateAsync(asyncClockConfig("InvOk"), 5, { spec: asyncClockSpec });
    } catch (err) {
      fullErr = err;
    }
    if (!(fullErr instanceof JobQueueFullError))
      throw new Error(`expected JobQueueFullError, got ${String(fullErr)}`);
    await first.cancel();
    await conn.close();
    console.log("OK: full job queue rejected at submit (C22)");
  } finally {
    child.kill();
  }
}

// ---------------------------------------------------------------------------
// TLS server-mode (mTLS) scenarios
// ---------------------------------------------------------------------------

// Throwaway PKI for the server-mode smoke scenarios, generated into a fresh
// temp dir with openssl (never committed). All private keys are chmod 600 to
// satisfy the client and server key-mode checks. The caller removes the dir
// in a finally block.
interface TestCerts {
  dir: string;
  caCrt: string;
  serverCrt: string;
  serverKey: string;
  cnOnlyServerCrt: string;
  cnOnlyServerKey: string;
  clientCrt: string;
  clientKey: string;
  rogueCaCrt: string;
  rogueClientCrt: string;
  rogueClientKey: string;
}

const runOpenssl = promisify(execFile);

async function generateTestCerts(): Promise<TestCerts> {
  const dir = await mkdtemp(tmpdir() + "/mirrorecma-tls-");
  const p = (f: string) => resolve(dir, f);
  const run = async (args: string[]) => {
    await runOpenssl("openssl", args, { cwd: dir });
  };

  // Self-signed CA.
  await run(["req", "-x509", "-newkey", "rsa:2048", "-keyout", "ca.key",
    "-out", "ca.crt", "-days", "30", "-nodes", "-subj", "/CN=MirrorECMA Test CA"]);
  // Server certificate with IP SAN, signed by the CA.
  await writeFile(p("server.ext"),
    "subjectAltName=IP:127.0.0.1\n" +
    "basicConstraints=CA:FALSE\n" +
    "keyUsage=digitalSignature,keyEncipherment\n" +
    "extendedKeyUsage=serverAuth\n");
  await run(["req", "-newkey", "rsa:2048", "-keyout", "server.key", "-out", "server.csr",
    "-nodes", "-subj", "/CN=127.0.0.1"]);
  await run(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "server.crt", "-days", "30", "-extfile", "server.ext"]);
  // CN-only server certificate: trusted chain, matching CN, deliberately no
  // SAN. A conforming client must reject it (guide C25).
  await writeFile(p("cn-server.ext"),
    "basicConstraints=CA:FALSE\n" +
    "keyUsage=digitalSignature,keyEncipherment\n" +
    "extendedKeyUsage=serverAuth\n");
  await run(["req", "-newkey", "rsa:2048", "-keyout", "cn-server.key", "-out", "cn-server.csr",
    "-nodes", "-subj", "/CN=localhost"]);
  await run(["x509", "-req", "-in", "cn-server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "cn-server.crt", "-days", "30", "-extfile", "cn-server.ext"]);
  // Client certificate with clientAuth EKU, signed by the CA.
  await writeFile(p("client.ext"),
    "basicConstraints=CA:FALSE\n" +
    "keyUsage=digitalSignature,keyEncipherment\n" +
    "extendedKeyUsage=clientAuth\n");
  await run(["req", "-newkey", "rsa:2048", "-keyout", "client.key", "-out", "client.csr",
    "-nodes", "-subj", "/CN=modelmirrors-client"]);
  await run(["x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "client.crt", "-days", "30", "-extfile", "client.ext"]);
  // Rogue CA + rogue client certificate (negative tests).
  await run(["req", "-x509", "-newkey", "rsa:2048", "-keyout", "rogue-ca.key",
    "-out", "rogue-ca.crt", "-days", "30", "-nodes", "-subj", "/CN=MirrorECMA Rogue CA"]);
  await writeFile(p("rogue-client.ext"),
    "basicConstraints=CA:FALSE\n" +
    "keyUsage=digitalSignature,keyEncipherment\n" +
    "extendedKeyUsage=clientAuth\n");
  await run(["req", "-newkey", "rsa:2048", "-keyout", "rogue-client.key", "-out", "rogue-client.csr",
    "-nodes", "-subj", "/CN=rogue-client"]);
  await run(["x509", "-req", "-in", "rogue-client.csr", "-CA", "rogue-ca.crt", "-CAkey", "rogue-ca.key",
    "-CAcreateserial", "-out", "rogue-client.crt", "-days", "30", "-extfile", "rogue-client.ext"]);

  // All private keys must be 0600 (the client and server both enforce this).
  for (const f of ["ca.key", "server.key", "cn-server.key", "client.key", "rogue-ca.key", "rogue-client.key"]) {
    await chmod(p(f), 0o600);
  }

  return {
    dir,
    caCrt: p("ca.crt"),
    serverCrt: p("server.crt"),
    serverKey: p("server.key"),
    cnOnlyServerCrt: p("cn-server.crt"),
    cnOnlyServerKey: p("cn-server.key"),
    clientCrt: p("client.crt"),
    clientKey: p("client.key"),
    rogueCaCrt: p("rogue-ca.crt"),
    rogueClientCrt: p("rogue-client.crt"),
    rogueClientKey: p("rogue-client.key"),
  };
}

// Valid mTLS client options for the throwaway CA.
function clientTls(certs: TestCerts): TlsOptions {
  return {
    caPath: certs.caCrt,
    certPath: certs.clientCrt,
    keyPath: certs.clientKey,
  };
}

// Async target factory for the TLS scenarios: each call opens a fresh mTLS
// connection, mirroring tcpTarget()'s fresh-connection-per-scenario pattern.
function tlsTarget(port: number, certs: TestCerts): Promise<TlsConnectTransport> {
  return connectTlsMirror("127.0.0.1", port, clientTls(certs));
}

async function testOverTls() {
  const certs = await generateTestCerts();
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn(BIN, [
    "--server", String(port), "--tls",
    "--cert", certs.serverCrt, "--key", certs.serverKey, "--ca", certs.caCrt,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  try {
    let connected = false;
    for (let i = 0; i < 50 && !connected; i++) {
      try {
        const probe = await tlsTarget(port, certs);
        await probe.close();
        connected = true;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!connected) throw new Error("mirror TLS server did not start listening");

    console.log("Running smoke tests over TLS (mTLS)");
    await testRegister(await tlsTarget(port, certs));
    await testRegisterMismatch(await tlsTarget(port, certs));
    await testRegisterTraces(await tlsTarget(port, certs));
    await testRegisterGenTraces(await tlsTarget(port, certs));
    await testExplore(await tlsTarget(port, certs));
    await testExploreSession(await tlsTarget(port, certs));
    await testRegisterInlineSpec(await tlsTarget(port, certs));
    console.log("OK: all TLS smoke tests passed");

    await testNegativeTls(port, certs);
    await testRegistryStub(port, certs);
  } finally {
    child.kill();
    await rm(certs.dir, { recursive: true, force: true });
  }
}

async function expectRejects(promise: Promise<unknown>, re?: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (re && !re.test(msg)) {
      throw new Error(`expected rejection matching ${re}, got: ${msg}`);
    }
    return;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A client certificate signed by a rogue CA must not be able to use the
// server. Note: in TLS 1.3 the client finishes its own handshake before the
// server's client-certificate rejection alert arrives, so connectTlsMirror
// can resolve here; the observable failure is that the server closed the
// connection and no register session can complete. The test accepts either
// a handshake rejection or a session that fails on first use.
async function assertWrongCaClientRejected(port: number, certs: TestCerts): Promise<void> {
  let t: TlsConnectTransport;
  try {
    t = await connectTlsMirror("127.0.0.1", port, {
      caPath: certs.caCrt,
      certPath: certs.rogueClientCrt,
      keyPath: certs.rogueClientKey,
    });
  } catch {
    console.log("OK: wrong-CA client rejected at handshake");
    return;
  }

  let sessionFailed = false;
  try {
    await withTimeout(testRegister(t), 30_000, "wrong-CA register");
  } catch {
    sessionFailed = true;
  }
  await t.close();
  if (!sessionFailed) throw new Error("wrong-CA client completed a register session");
  console.log("OK: wrong-CA client rejected (handshake ok, no usable session)");
}

async function testNegativeTls(port: number, certs: TestCerts) {
  console.log("Running negative mTLS tests");
  await assertWrongCaClientRejected(port, certs);
  await assertCnOnlyServerRejected(certs);
  await assertTls12OnlyServerRejected(certs);

  await expectRejects(
    connectTlsMirror("127.0.0.1", port, { ...clientTls(certs), pin: "0".repeat(64) }),
    /fingerprint mismatch/,
  );
  console.log("OK: direct pin mismatch rejected");

  if (process.platform !== "win32") {
    const looseKey = resolve(certs.dir, "client-loose.key");
    await writeFile(looseKey, await readFile(certs.clientKey));
    await chmod(looseKey, 0o644);
    await expectRejects(
      connectTlsMirror("127.0.0.1", port, { ...clientTls(certs), keyPath: looseKey }),
      /chmod 0600/,
    );
    console.log("OK: client key mode 0644 rejected");
  }
}

async function assertCnOnlyServerRejected(certs: TestCerts): Promise<void> {
  const port = 30000 + Math.floor(Math.random() * 20000);
  // The mirror server validates its own certificate and refuses to start with
  // a CN-only leaf. Use a minimal TLS peer so this test reaches the client's
  // identity verifier instead of stopping at server configuration validation.
  const child = spawn("openssl", [
    "s_server", "-Verify", "1", "-verify_return_error", "-tls1_3", "-quiet",
    "-accept", String(port),
    "-cert", certs.cnOnlyServerCrt, "-key", certs.cnOnlyServerKey,
    "-CAfile", certs.caCrt, "-naccept", "1",
  ], { stdio: ["ignore", "inherit", "inherit"] });
  try {
    let sawSanRejection = false;
    for (let i = 0; i < 50 && !sawSanRejection; i++) {
      try {
        const t = await connectTlsMirror("127.0.0.1", port, {
          ...clientTls(certs),
          servername: "localhost",
        });
        await t.close();
        throw new Error("CN-only certificate was accepted");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/certificate SAN/.test(message)) sawSanRejection = true;
        else if (/CN-only certificate was accepted/.test(message)) throw err;
        else await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!sawSanRejection) throw new Error("CN-only server did not reach SAN verification");
    console.log("OK: CN-only server certificate rejected (SAN required)");
  } finally {
    child.kill();
  }
}

async function assertTls12OnlyServerRejected(certs: TestCerts): Promise<void> {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn("openssl", [
    "s_server", "-Verify", "1", "-verify_return_error", "-tls1_2", "-quiet",
    "-accept", String(port),
    "-cert", certs.serverCrt, "-key", certs.serverKey,
    "-CAfile", certs.caCrt, "-naccept", "1",
  ], { stdio: ["ignore", "inherit", "inherit"] });
  try {
    let rejected = false;
    for (let i = 0; i < 50 && !rejected; i++) {
      try {
        const t = await connectTlsMirror("127.0.0.1", port, clientTls(certs));
        await t.close();
        throw new Error("TLS 1.2-only server was accepted");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/TLS 1\.2-only server was accepted/.test(message)) throw error;
        if (/ECONNREFUSED/.test(message)) await new Promise((r) => setTimeout(r, 100));
        else rejected = true;
      }
    }
    if (!rejected) throw new Error("TLS 1.2-only peer did not become ready");
    console.log("OK: TLS 1.2-only server rejected (TLS 1.3 required)");
  } finally {
    child.kill();
  }
}

// Fingerprint of the server leaf cert, computed the same way the client does:
// SHA-256 over the raw DER encoding, lowercase hex.
async function serverFingerprint(certs: TestCerts): Promise<string> {
  const pem = await readFile(certs.serverCrt, "utf8");
  return sha256Hex(new X509Certificate(pem).raw);
}

async function testRegistryStub(port: number, certs: TestCerts) {
  const realPin = await serverFingerprint(certs);
  const wrongPin = "0".repeat(64);

  // Canned Consul health payloads, consumed one per discovery request:
  // 1. single correct entry (positive), 2. wrong pin then correct pin
  // (failover), 3. malformed JSON (fail closed), 4. empty array (fail closed).
  const malformed = "{this is not json";
  const queue: unknown[] = [
    [{ Service: { ID: "mirror-a", Address: "127.0.0.1", Port: port, Meta: { "cert-sha256": realPin } } }],
    [
      { Service: { ID: "mirror-wrong", Address: "127.0.0.1", Port: port, Meta: { "cert-sha256": wrongPin } } },
      { Service: { ID: "mirror-good", Address: "127.0.0.1", Port: port, Meta: { "cert-sha256": realPin } } },
    ],
    malformed,
    [],
  ];

  const server = createServer((req, res) => {
    void req;
    const body = queue.shift() ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("registry stub: no address");
  const stubUrl = `http://127.0.0.1:${addr.port}`;
  try {
    console.log(`Running registry stub tests (stub ${stubUrl})`);

    // Positive: discovery + connect + a full register session.
    const t = await connectMirrorFromRegistry(stubUrl, clientTls(certs));
    if (t.peerFingerprint !== realPin)
      throw new Error(`registry pin mismatch: expected ${realPin}, got ${t.peerFingerprint}`);
    await testRegister(t);
    console.log("OK: registry discovery connected and completed register");

    // Failover: first entry advertises the wrong pin, second the right one.
    const t2 = await connectMirrorFromRegistry(stubUrl, clientTls(certs));
    if (t2.peerFingerprint !== realPin)
      throw new Error(`registry failover: expected ${realPin}, got ${t2.peerFingerprint}`);
    await testRegister(t2);
    console.log("OK: registry failover picked the correct candidate");

    // Fail closed on malformed JSON and on an empty result.
    await expectRejects(
      connectMirrorFromRegistry(stubUrl, clientTls(certs)),
      /no mirror candidates discovered/,
    );
    console.log("OK: registry malformed JSON fails closed");
    await expectRejects(
      connectMirrorFromRegistry(stubUrl, clientTls(certs)),
      /no mirror candidates discovered/,
    );
    console.log("OK: registry empty result fails closed");
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

async function main() {
  await testRegister();
  await testRegisterMismatch();
  await testRegisterTraces();
  await testRegisterGenTraces();
  await testExplore();
  await testExploreSession();
  await testRegisterInlineSpec();
  await testOverTcp();
  await testValidateAndAsyncTcp();
  await testQueueFull();
  if (process.env.RUNFILES) {
    // Bazel js_test wrapper: RUNFILES is set. The ModelMirros commit pinned in
    // MODULE.bazel (9cffb8a) is the newest one that still has a Bazel build,
    // and that build compiles a TLS stub that exits with "TLS is not available
    // in the Bazel build (cabal-only)" — server mode is cabal-only upstream.
    // stdio + TCP above already passed; the TLS/registry scenarios must run
    // against a cabal-built binary with RUNFILES unset:
    //   MIRROR_BIN=<...> NPM_CONFIG_CACHE=<writable> npx --yes tsx test/smoke.test.ts
    console.log("SKIP: TLS/registry smoke underway only outside Bazel (RUNFILES is set; the Bazel-pinned ModelMirros build is a cabal-only TLS stub — run `MIRROR_BIN=<cabal binary> npx tsx test/smoke.test.ts` for the TLS/registry scenarios).");
  } else {
    await testOverTls();
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
