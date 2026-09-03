import { strict as assert } from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

import {
  CompiledAdapterRegistry,
  MIRRORECMA_TARGET_PROFILE,
  ModelInterfaceRegistrationError,
  STATE_COMPUTER_CONTRACT_VERSION,
  runClientNegotiated,
  runClientWithTracesNegotiated,
  type CompiledAdapterSelection,
  type DynamicHandlerSelection,
  type LocalBinding,
} from "../src/negotiated.js";
import {
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
  semanticDigestFromHex,
  type ContractV1,
  type SemanticDescriptor,
} from "../src/model-interface.js";
import { DescriptorCache } from "../src/descriptor-cache.js";
import type { NativeModelValue } from "../src/dynamic-binding.js";
import {
  connectTlsMirror,
  spawnMirror,
  type Transport,
} from "../src/transport.js";
import type { ApalacheConfig } from "../src/protocol.js";
import {
  bindCounter,
  CounterModelInterface,
  CounterSemanticDigest,
  type CounterBinding,
  type CounterPort,
} from "./fixtures/model-interface/counter/generated/CounterMirror.generated.js";
import {
  createModelInterfacePki,
  modelInterfaceTlsOptions,
  removeModelInterfacePki,
  type ModelInterfacePki,
} from "./support/model-interface-pki.js";

process.noDeprecation = true;

const MIRROR_BIN = process.env.MIRROR_BIN ?? "";
if (MIRROR_BIN.length === 0) {
  console.error("MIRROR_BIN not set");
  process.exit(1);
}

const MIRRORS_ROOT = process.env.MIRRORS_ROOT ?? "/home/nzsn/Repos/Mirrors";
const MIRRORECMA_ROOT = process.env.MIRRORECMA_ROOT ?? "/home/nzsn/Repos/MirrorECMA";
const COUNTER_SPEC = resolve(MIRRORS_ROOT, "specs/Counter.tla");
const COUNTER_TRACE = resolve(
  MIRRORECMA_ROOT,
  "test/fixtures/model-interface/counter/counter.itf.json",
);

const config: ApalacheConfig = {
  specPath: COUNTER_SPEC,
  invariant: "TraceComplete",
  lengthBound: 6,
  constInit: "CInit",
  paramVars: "parameters",
};

interface Probe {
  readonly events: string[];
  factoryCalls: number;
  sutCalls: number;
  disposeCalls: number;
  generated?: CounterBinding;
}

class MutableCounter {
  count = 0n;

  constructor(private readonly probe: Probe) {}

  reset(): void {
    this.probe.sutCalls += 1;
    this.probe.events.push("sut:initialize");
    this.count = 0n;
  }

  increment(stride: bigint): void {
    this.probe.sutCalls += 1;
    this.probe.events.push(`sut:tick:${stride}`);
    this.count += stride;
  }

  observe(offset: bigint): bigint {
    this.probe.sutCalls += 1;
    this.probe.events.push("sut:observe");
    return this.count + offset;
  }
}

function makeProbe(): Probe {
  return { events: [], factoryCalls: 0, sutCalls: 0, disposeCalls: 0 };
}

function makeSelection(
  probe: Probe,
  options: { readonly digest?: string; readonly observerOffset?: bigint } = {},
): CompiledAdapterSelection {
  const digest = options.digest ?? CounterSemanticDigest;
  const metadata = options.digest === undefined
    ? CounterModelInterface
    : { ...CounterModelInterface, semanticDigest: digest };
  const semanticDigest = semanticDigestFromHex(digest);
  const adapterId = "counter-mutable/v1";
  const key = {
    semanticDigest,
    adapterId,
    targetProfile: MIRRORECMA_TARGET_PROFILE,
    stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
  };
  const registry = new CompiledAdapterRegistry([{
    key,
    factory: (effectiveConfig): LocalBinding => {
      probe.factoryCalls += 1;
      probe.events.push("factory");
      const sut = new MutableCounter(probe);
      const port: CounterPort = {
        initialize: () => sut.reset(),
        tick: ({ stride }) => sut.increment(stride),
        observe: () => ({ count: sut.observe(options.observerOffset ?? 0n) }),
      };
      const generated = bindCounter(port, effectiveConfig);
      probe.generated = generated;
      return {
        semanticDigest,
        computer: (action, payload, previousState) => {
          probe.events.push(`computer:${action}`);
          return generated.computer(action, payload, previousState);
        },
        assertCompatibleConfig: (candidate) => {
          probe.events.push("compatible");
          if (candidate.paramVars !== "parameters") {
            throw new Error("Counter requires paramVars=parameters");
          }
        },
        coverage: generated.coverage,
        dispose: () => {
          probe.disposeCalls += 1;
          probe.events.push("dispose");
        },
      };
    },
  }]);

  return {
    metadata,
    adapterId,
    targetProfile: MIRRORECMA_TARGET_PROFILE,
    stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
    registry,
  };
}

interface DynamicArtifacts {
  readonly contract: ContractV1;
  readonly descriptor: SemanticDescriptor;
}

async function loadDynamicArtifacts(): Promise<DynamicArtifacts> {
  const raw = JSON.parse(await readFile(
    resolve(MIRRORECMA_ROOT, "test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json"),
    "utf8",
  )) as Record<string, any>;
  const { contract, semanticDigest: _semantic, provenanceDigest: _provenanceDigest, provenance: _provenance, ...rest } = raw;
  return {
    contract,
    descriptor: decodeSemanticDescriptor({
      ...rest,
      schema: "mirrors.model-interface-descriptor/v1",
    }),
  };
}

function makeDynamicSelection(
  probe: Probe,
  artifacts: DynamicArtifacts,
  descriptorCache: DescriptorCache,
  observerOffset = 0n,
): DynamicHandlerSelection {
  const sut = new MutableCounter(probe);
  return {
    mode: "dynamic",
    contract: artifacts.contract,
    descriptorCache,
    registry: {
      semanticDigest: semanticDescriptorDigest(artifacts.descriptor),
      actions: {
        Initialize: () => sut.reset(),
        Tick: (inputs) => sut.increment(inputs.Stride as bigint),
      },
      observations: {
        Count: (): NativeModelValue => sut.observe(observerOffset),
      },
    },
    dispose: () => {
      probe.disposeCalls += 1;
      probe.events.push("dispose");
    },
  };
}

interface RecordedTransport {
  readonly transport: Transport;
  readonly received: string[];
  readonly sent: string[];
  readonly closeCalls: () => number;
}

function recordTransport(inner: Transport, probe?: Probe): RecordedTransport {
  const received: string[] = [];
  const sent: string[] = [];
  let closeCalls = 0;
  const transport: Transport = {
    mode: inner.mode,
    send: (line) => {
      sent.push(line);
      inner.send(line);
    },
    close: async () => {
      closeCalls += 1;
      return inner.close();
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      const iterator = inner[Symbol.asyncIterator]();
      return {
        next: async () => {
          const result = await iterator.next();
          if (!result.done) {
            received.push(result.value);
            if (probe !== undefined) {
              const message = JSON.parse(result.value) as {
                proto_step?: string;
                modelInterface?: { status?: string };
              };
              if (message.proto_step === "spec_validated" &&
                  message.modelInterface?.status !== undefined) {
                probe.events.push(`wire:${message.modelInterface.status}`);
              }
            }
          }
          return result;
        },
      };
    },
  };
  return { transport, received, sent, closeCalls: () => closeCalls };
}

function protocolSteps(lines: readonly string[]): string[] {
  return lines.map((line) => {
    const value = JSON.parse(line) as { proto_step?: unknown };
    return typeof value.proto_step === "string" ? value.proto_step : "<missing>";
  });
}

function assertMatchedThenDone(recording: RecordedTransport): void {
  const messages = recording.received.map((line) => JSON.parse(line) as {
    proto_step?: string;
    modelInterface?: { status?: string; semanticDigest?: string };
  });
  const validated = messages.find((message) => message.proto_step === "spec_validated");
  assert.equal(validated?.modelInterface?.status, "matched");
  assert.equal(
    validated?.modelInterface?.semanticDigest,
    `sha256:${CounterSemanticDigest}`,
  );
  assert.equal(messages.at(-1)?.proto_step, "all_steps_done");
}

function assertFreshBindingLifecycle(probe: Probe): void {
  assert.equal(probe.factoryCalls, 1, "one fresh binding factory must run");
  assert.equal(probe.disposeCalls, 1, "created binding must be disposed exactly once");
  assert.equal(probe.events[0], "wire:matched");
  assert.equal(probe.events[1], "factory");
  assert.equal(probe.events[2], "compatible");
  assert.equal(probe.events.at(-1), "dispose");
  assert.ok(probe.generated, "factory did not expose generated binding coverage");
  probe.generated.assertAllActionsCovered();
  assertReplayOrder(probe.events);
  const tickEvents = probe.events.filter((event) => event.startsWith("sut:tick:"));
  assert.ok(tickEvents.length > 0, "Counter replay did not call Tick");
  for (const event of tickEvents) {
    assert.ok(
      event === "sut:tick:2" || event === "sut:tick:3",
      `Counter received stride outside STRIDES: ${event}`,
    );
  }
}

function assertReplayOrder(events: readonly string[]): void {
  let index = 3;
  while (events[index] !== "dispose") {
    const compute = events[index];
    assert.ok(compute?.startsWith("computer:"), `expected computer dispatch at event ${index}`);
    const action = compute.slice("computer:".length);
    const mutation = events[index + 1];
    if (action === "init") {
      assert.equal(mutation, "sut:initialize");
    } else if (action === "tick") {
      assert.ok(mutation?.startsWith("sut:tick:"), `expected tick mutation at event ${index + 1}`);
    } else {
      throw new Error(`unexpected generated action in event log: ${action}`);
    }
    assert.equal(events[index + 2], "sut:observe");
    index += 3;
  }
  assert.equal(index, events.length - 1, "dispose must be the final event");
}

function assertCountOnlyReports(recording: RecordedTransport): void {
  const reports = recording.sent
    .map((line) => JSON.parse(line) as { proto_step?: string; state?: unknown })
    .filter((message) => message.proto_step === "report_state");
  assert.ok(reports.length > 0, "replay emitted no report_state messages");
  for (const report of reports) {
    assert.ok(typeof report.state === "object" && report.state !== null);
    assert.deepEqual(Object.keys(report.state).sort(), ["count"]);
  }
}

async function assertAuthoritativeCounterSource(): Promise<void> {
  const source = await readFile(COUNTER_SPEC);
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "405b4ffb80464cdf919d986e142b180e044c41caf8e6aabe978db0e8e7aa0340",
    "Counter.tla differs from the source authenticated by the generated binding",
  );
}

async function expectRejects(promise: Promise<void>, expected: RegExp): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    assert.match(caught.message, expected);
    return caught;
  }
  throw new Error("expected negotiated run to reject");
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 180_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
  return port;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function startTlsServer(
  pki: ModelInterfacePki,
  allowClient: boolean,
  descriptorRead = false,
): Promise<{ readonly port: number; readonly child: ChildProcess }> {
  const port = await freePort();
  const args = [
    "--server", String(port), "--tls",
    "--cert", pki.serverCrt,
    "--key", pki.serverKey,
    "--ca", pki.caCrt,
  ];
  if (allowClient) {
    args.push("--model-interface-allow-client", pki.clientFingerprint);
  }
  if (descriptorRead) args.push("--model-interface-descriptor-read");
  const child = spawn(MIRROR_BIN, args, { stdio: ["ignore", "inherit", "inherit"] });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`mirror TLS server exited with ${child.exitCode}`);
    }
    try {
      const probe = await connectTlsMirror(
        "127.0.0.1",
        port,
        modelInterfaceTlsOptions(pki),
      );
      await probe.close();
      return { port, child };
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  await stopServer(child);
  throw new Error("mirror TLS server did not become ready");
}

async function testStdioGeneratedTrace(): Promise<void> {
  const probe = makeProbe();
  const recording = recordTransport(spawnMirror(MIRROR_BIN), probe);
  const source = await readFile(COUNTER_SPEC, "utf8");
  await withTimeout(
    runClientNegotiated(
      recording.transport,
      { ...config, specPath: "Counter.tla" },
      { numTraces: 1, view: "View" },
      makeSelection(probe),
      { spec: { sources: [source] } },
    ),
    "negotiated stdio Counter",
  );

  assertMatchedThenDone(recording);
  assertFreshBindingLifecycle(probe);
  assertCountOnlyReports(recording);
  assert.equal(recording.closeCalls(), 1);
  assert.ok(probe.sutCalls > 0);
  assert.ok(probe.events.indexOf("wire:matched") < probe.events.indexOf("factory"));
  assert.ok(probe.events.indexOf("factory") < probe.events.indexOf("sut:initialize"));
  console.log("OK: Counter compiled interface matched and replayed a real Apalache trace over stdio");
}

async function testWrongDigest(): Promise<void> {
  const probe = makeProbe();
  const recording = recordTransport(spawnMirror(MIRROR_BIN), probe);
  const error = await expectRejects(
    runClientWithTracesNegotiated(
      recording.transport,
      config,
      [COUNTER_TRACE],
      makeSelection(probe, { digest: "0".repeat(64) }),
    ),
    /digest mismatch|interface_digest_mismatch/,
  );
  assert.ok(error instanceof ModelInterfaceRegistrationError);
  assert.equal(error.code, "interface_digest_mismatch");
  assert.equal(probe.factoryCalls, 0);
  assert.equal(probe.sutCalls, 0);
  assert.equal(probe.disposeCalls, 0);
  assert.ok(!protocolSteps(recording.received).includes("initial_state"));
  assert.equal(recording.closeCalls(), 1);
  console.log("OK: wrong digest failed before binding creation and before initial_state");
}

async function testWrongObserver(): Promise<void> {
  const probe = makeProbe();
  const recording = recordTransport(spawnMirror(MIRROR_BIN), probe);
  await expectRejects(
    runClientWithTracesNegotiated(
      recording.transport,
      config,
      [COUNTER_TRACE],
      makeSelection(probe, { observerOffset: 1n }),
    ),
    /step mismatch/,
  );
  assert.equal(probe.factoryCalls, 1);
  assert.equal(probe.disposeCalls, 1);
  assert.ok(protocolSteps(recording.received).includes("step_mismatch"));
  assert.ok(protocolSteps(recording.received).includes("initial_state"));
  assert.equal(probe.events.at(-1), "dispose");
  assertReplayOrder(probe.events);
  assertCountOnlyReports(recording);
  console.log("OK: incorrect local observer reached ordinary step_mismatch and disposed once");
}

function assertDynamicReplay(
  recording: RecordedTransport,
  probe: Probe,
  status: "resolved" | "not_modified",
): void {
  const messages = recording.received.map((line) => JSON.parse(line) as {
    proto_step?: string;
    modelInterface?: { status?: string };
  });
  assert.equal(
    messages.find((message) => message.proto_step === "spec_validated")?.modelInterface?.status,
    status,
  );
  assert.equal(messages.at(-1)?.proto_step, "all_steps_done");
  assert.equal(probe.factoryCalls, 0);
  assert.equal(probe.disposeCalls, 1);
  assert.equal(probe.events[0], `wire:${status}`);
  assert.equal(probe.events.at(-1), "dispose");
  const effects = probe.events.slice(1, -1);
  assert.ok(effects.length > 0 && effects.length % 2 === 0);
  for (let index = 0; index < effects.length; index += 2) {
    assert.ok(
      effects[index] === "sut:initialize" || effects[index]?.startsWith("sut:tick:"),
      `expected dynamic action at event ${index}`,
    );
    assert.equal(effects[index + 1], "sut:observe");
  }
  assertCountOnlyReports(recording);
}

async function testDynamicStdioAndCache(artifacts: DynamicArtifacts): Promise<void> {
  const cache = new DescriptorCache();
  const firstProbe = makeProbe();
  const first = recordTransport(spawnMirror(MIRROR_BIN), firstProbe);
  await withTimeout(
    runClientWithTracesNegotiated(
      first.transport,
      config,
      [COUNTER_TRACE],
      makeDynamicSelection(firstProbe, artifacts, cache),
    ),
    "dynamic stdio Counter resolved",
  );
  assertDynamicReplay(first, firstProbe, "resolved");
  const firstRequest = JSON.parse(first.sent[0]!) as { modelInterface?: Record<string, unknown> };
  assert.equal(firstRequest.modelInterface?.request, "descriptor");
  assert.equal(firstRequest.modelInterface?.ifNoneMatch, undefined);

  const secondProbe = makeProbe();
  const second = recordTransport(spawnMirror(MIRROR_BIN), secondProbe);
  await withTimeout(
    runClientWithTracesNegotiated(
      second.transport,
      config,
      [COUNTER_TRACE],
      makeDynamicSelection(secondProbe, artifacts, cache),
    ),
    "dynamic stdio Counter not_modified",
  );
  assertDynamicReplay(second, secondProbe, "not_modified");
  const secondRequest = JSON.parse(second.sent[0]!) as { modelInterface?: Record<string, unknown> };
  assert.equal(
    secondRequest.modelInterface?.ifNoneMatch,
    `sha256:${CounterSemanticDigest}`,
  );
  console.log("OK: Counter dynamic descriptor replay resolved then reused verified cache over stdio");
}

async function testDynamicWrongObserver(artifacts: DynamicArtifacts): Promise<void> {
  const probe = makeProbe();
  const recording = recordTransport(spawnMirror(MIRROR_BIN), probe);
  await expectRejects(
    runClientWithTracesNegotiated(
      recording.transport,
      config,
      [COUNTER_TRACE],
      makeDynamicSelection(probe, artifacts, new DescriptorCache(), 1n),
    ),
    /step mismatch/,
  );
  assert.equal(probe.disposeCalls, 1);
  assert.ok(probe.sutCalls > 0);
  assert.ok(protocolSteps(recording.received).includes("step_mismatch"));
  assert.equal(probe.events.at(-1), "dispose");
  console.log("OK: incorrect dynamic observer reached ordinary step_mismatch");
}

async function testAuthorizedTls(pki: ModelInterfacePki): Promise<void> {
  const server = await startTlsServer(pki, true);
  try {
    const probe = makeProbe();
    const inner = await connectTlsMirror(
      "127.0.0.1",
      server.port,
      modelInterfaceTlsOptions(pki),
    );
    const recording = recordTransport(inner, probe);
    await withTimeout(
      runClientWithTracesNegotiated(
        recording.transport,
        config,
        [COUNTER_TRACE],
        makeSelection(probe),
      ),
      "authorized negotiated mTLS Counter",
    );
    assertMatchedThenDone(recording);
    assertFreshBindingLifecycle(probe);
    assertCountOnlyReports(recording);
    assert.deepEqual(probe.generated?.coverage(), { Initialize: 1, Tick: 2 });
    assert.equal(recording.closeCalls(), 1);
  } finally {
    await stopServer(server.child);
  }
  console.log("OK: allowlisted mTLS client matched and replayed Counter");
}

async function testDynamicAuthorizedTls(
  pki: ModelInterfacePki,
  artifacts: DynamicArtifacts,
): Promise<void> {
  const server = await startTlsServer(pki, true, true);
  try {
    const probe = makeProbe();
    const inner = await connectTlsMirror("127.0.0.1", server.port, modelInterfaceTlsOptions(pki));
    const recording = recordTransport(inner, probe);
    await withTimeout(
      runClientWithTracesNegotiated(
        recording.transport,
        config,
        [COUNTER_TRACE],
        makeDynamicSelection(probe, artifacts, new DescriptorCache()),
      ),
      "authorized descriptor-read mTLS Counter",
    );
    assertDynamicReplay(recording, probe, "resolved");
    assert.equal(recording.closeCalls(), 1);
  } finally {
    await stopServer(server.child);
  }
  console.log("OK: allowlisted descriptor-read mTLS client replayed dynamic Counter");
}

async function testDynamicTlsWithoutDescriptorRead(
  pki: ModelInterfacePki,
  artifacts: DynamicArtifacts,
): Promise<void> {
  const server = await startTlsServer(pki, true, false);
  try {
    const probe = makeProbe();
    const inner = await connectTlsMirror("127.0.0.1", server.port, modelInterfaceTlsOptions(pki));
    const recording = recordTransport(inner, probe);
    const error = await expectRejects(
      withTimeout(
        runClientWithTracesNegotiated(
          recording.transport,
          config,
          [COUNTER_TRACE],
          makeDynamicSelection(probe, artifacts, new DescriptorCache()),
        ),
        "mTLS Counter without descriptor-read",
      ),
      /register failed|descriptor|unavailable|unauthorized/,
    );
    assert.ok(error instanceof ModelInterfaceRegistrationError);
    assert.equal(probe.factoryCalls, 0);
    assert.equal(probe.sutCalls, 0);
    assert.equal(probe.disposeCalls, 0);
    assert.ok(!protocolSteps(recording.received).includes("initial_state"));
    assert.equal(recording.closeCalls(), 1);
  } finally {
    await stopServer(server.child);
  }
  console.log("OK: allowlisted mTLS without descriptor-read denied dynamic mode before callbacks");
}

async function testTlsWithoutAllowlist(pki: ModelInterfacePki): Promise<void> {
  const server = await startTlsServer(pki, false);
  try {
    const probe = makeProbe();
    const inner = await connectTlsMirror(
      "127.0.0.1",
      server.port,
      modelInterfaceTlsOptions(pki),
    );
    const recording = recordTransport(inner, probe);
    const error = await expectRejects(
      withTimeout(
        runClientWithTracesNegotiated(
          recording.transport,
          config,
          [COUNTER_TRACE],
          makeSelection(probe),
        ),
        "non-allowlisted negotiated mTLS Counter",
      ),
      /register failed|negotiation|unauthorized|unsupported/,
    );
    assert.ok(error instanceof ModelInterfaceRegistrationError);
    assert.equal(error.code, "interface_unavailable");
    assert.equal(probe.factoryCalls, 0);
    assert.equal(probe.sutCalls, 0);
    assert.equal(probe.disposeCalls, 0);
    assert.ok(!protocolSteps(recording.received).includes("initial_state"));
    assert.equal(recording.closeCalls(), 1);
  } finally {
    await stopServer(server.child);
  }
  console.log("OK: mTLS CA trust without model-interface allowlist failed before replay");
}

async function main(): Promise<void> {
  await assertAuthoritativeCounterSource();
  assert.equal(
    CounterSemanticDigest,
    "193d6cc187d05c18f02ad483a44f8ad0c1634b02083df241df08b9281b045d1c",
  );
  await testStdioGeneratedTrace();
  await testWrongDigest();
  await testWrongObserver();
  const dynamicArtifacts = await loadDynamicArtifacts();
  assert.equal(semanticDescriptorDigest(dynamicArtifacts.descriptor), CounterSemanticDigest);
  await testDynamicStdioAndCache(dynamicArtifacts);
  await testDynamicWrongObserver(dynamicArtifacts);

  const pki = await createModelInterfacePki();
  try {
    await testAuthorizedTls(pki);
    await testDynamicAuthorizedTls(pki, dynamicArtifacts);
    await testDynamicTlsWithoutDescriptorRead(pki, dynamicArtifacts);
    await testTlsWithoutAllowlist(pki);
  } finally {
    await removeModelInterfacePki(pki);
  }
  console.log("MODEL INTERFACE COUNTER SMOKE GREEN");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
