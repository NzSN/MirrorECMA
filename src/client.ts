import { connectMirrorTcp, connectMirrorTls, spawnMirror } from "./transport.js";
import {
  MirrorMessage,
  State,
  StateComputer,
  ApalacheConfig,
  TraceGenerationConfig,
  encodeClientMessage,
  encodeState,
  decodeMirrorMessage,
  prettifyState,
} from "./protocol.js";
import { discoverServices } from "./discovery.js";
import type {
  TcpConnectOptions,
  TlsConnectOptions,
  Transport,
} from "./transport.js";

export type { State, StateComputer, ApalacheConfig, TraceGenerationConfig } from "./protocol.js";
export type { TcpConnectOptions, TlsConnectOptions, Transport } from "./transport.js";
export type { ServiceInfo } from "./discovery.js";

export interface StdioEndpoint {
  binPath: string;
}

export interface TcpEndpoint {
  server: TcpConnectOptions;
}

export interface TlsEndpoint {
  server: TlsConnectOptions;
}

export interface RegistryEndpoint {
  registry: string;
  tls: Omit<TlsConnectOptions, "host" | "port" | "certSha256">;
  serviceName?: string;
}

export type MirrorEndpoint = StdioEndpoint | TcpEndpoint | TlsEndpoint | RegistryEndpoint;

export type ClientTarget = string | MirrorEndpoint;

function isTlsServer(
  s: TcpConnectOptions | TlsConnectOptions
): s is TlsConnectOptions {
  return "ca" in s || "cert" in s || "key" in s;
}

export async function connectMirror(target: ClientTarget): Promise<Transport> {
  if (typeof target === "string") return spawnMirror(target);
  if ("binPath" in target) return spawnMirror(target.binPath);
  if ("registry" in target) {
    const candidates = await discoverServices(target.registry, {
      ...(target.serviceName !== undefined ? { serviceName: target.serviceName } : {}),
    });
    let lastError: unknown;
    for (const c of candidates) {
      try {
        return await connectMirrorTls({
          ...target.tls,
          host: c.address,
          port: c.port,
          ...(c.certSha256 !== undefined ? { certSha256: c.certSha256 } : {}),
        });
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      candidates.length === 0
        ? `no healthy "modelmirrors" services in registry ${target.registry}`
        : `no usable mirror among ${candidates.length} candidate(s): ${String(lastError)}`
    );
  }
  if (isTlsServer(target.server)) return connectMirrorTls(target.server);
  return connectMirrorTcp(target.server);
}

export async function runClientWithTraces(
  target: ClientTarget,
  apalacheConfig: ApalacheConfig,
  tracePaths: string[],
  compute: StateComputer
): Promise<void> {
  const t = await connectMirror(target);
  t.send(encodeClientMessage({
    proto_step: "register_traces",
    apalacheConfig,
    itfTracePaths: tracePaths,
  }));
  await mainLoop(t, compute);
}

export async function runClient(
  target: ClientTarget,
  apalacheConfig: ApalacheConfig,
  config: TraceGenerationConfig,
  compute: StateComputer
): Promise<void> {
  const t = await connectMirror(target);
  t.send(encodeClientMessage({
    proto_step: "register",
    apalacheConfig,
    traceConfig: config,
  }));
  await mainLoop(t, compute);
}

export async function runClientGenTraces(
  target: ClientTarget,
  apalacheConfig: ApalacheConfig,
  destPath: string,
  config: TraceGenerationConfig
): Promise<void> {
  const t = await connectMirror(target);
  t.send(encodeClientMessage({
    proto_step: "register_trace_gen",
    apalacheConfig,
    traceConfig: config,
    destPath,
  }));
  await genTracesLoop(t);
}

async function mainLoop(t: Transport, compute: StateComputer): Promise<void> {
  const it = t[Symbol.asyncIterator]();

  const msg0 = await recv(it);
  if (msg0.proto_step === "protocol_error") { await t.close(); throw new Error(msg0.error); }
  if (msg0.proto_step === "register_error") { await t.close(); throw new Error(`register failed: ${msg0.error}`); }
  if (msg0.proto_step !== "spec_validated") {
    await t.close();
    throw new Error(`expected spec_validated, got ${msg0.proto_step}`);
  }
  if (typeof msg0.result !== "string") {
    await t.close();
    throw new Error(`spec invalid: ${msg0.result.invalid}`);
  }

  let msg = await recv(it);
  let state: State = {};
  let lastParam: State = {}
  let lastAction = "";
  for (;;) {
    switch (msg.proto_step) {
      case "initial_state":
        lastAction = msg.action;
        state = compute(msg.action, msg.state, {});
        t.send(JSON.stringify({ proto_step: "report_state", state: encodeState(state) }));
        break;
      case "step_ok":
        break;
      case "all_steps_done":
        await t.close();
        return;
      case "next_step":
        lastAction = msg.action;
        state = compute(msg.action, msg.parameters, state);
        lastParam = msg.parameters;
        t.send(JSON.stringify({ proto_step: "report_state", state: encodeState(state) }));
        break;
      case "step_mismatch":
        await t.close();
        throw new Error(
            `step mismatch on action "${msg.action ?? lastAction}" with param "${lastParam}": expected ${JSON.stringify(prettifyState(msg.expected))}, got ${JSON.stringify(prettifyState(msg.actual))}`
        );
      case "protocol_error":
        await t.close();
        throw new Error(msg.error);
      case "register_error":
        await t.close();
        throw new Error(`register failed: ${msg.error}`);
      default:
        await t.close();
        throw new Error(`unexpected message: ${msg.proto_step}`);
    }
    msg = await recv(it);
  }
}

export function presetClient(states: State[]): StateComputer {
  let i = 0;
  return () => {
    if (i >= states.length) throw new Error("presetClient exhausted");
    return states[i++]!;
  };
}

async function recv(it: AsyncIterator<string>): Promise<MirrorMessage> {
  const { value, done } = await it.next();
  if (done) throw new Error("transport closed unexpectedly");
  return decodeMirrorMessage(value);
}

async function genTracesLoop(t: Transport): Promise<void> {
  const it = t[Symbol.asyncIterator]();

  const msg = await recv(it);
  if (msg.proto_step === "protocol_error") { await t.close(); throw new Error(msg.error); }
  if (msg.proto_step === "register_error") { await t.close(); throw new Error(`register failed: ${msg.error}`); }
  if (msg.proto_step === "gen_traces_done") { await t.close(); return; }
  await t.close();
  throw new Error(`expected gen_traces_done, got ${msg.proto_step}`);
}
