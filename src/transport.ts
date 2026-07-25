import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { connect as connectTcp } from "node:net";
import { connect as connectTls, type ConnectionOptions } from "node:tls";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";

export interface Transport {
  send(line: string): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
  close(): Promise<number>;
}

export interface TcpConnectOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export interface TlsConnectOptions extends TcpConnectOptions {
  ca: string | Buffer;
  cert: string | Buffer;
  key: string | Buffer;
  servername?: string;
  certSha256?: string;
}

export class FingerprintMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(`certificate fingerprint mismatch: expected ${expected}, got ${actual}`);
    this.name = "FingerprintMismatchError";
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

function normalizeFingerprint(fp: string): string {
  return fp.replace(/:/g, "").toLowerCase();
}

function streamTransport(
  input: Readable,
  output: Writable,
  closeFn: () => Promise<number>
): Transport {
  const buffer: string[] = [];
  const waiters: ((v: IteratorResult<string>) => void)[] = [];
  let closed = false;

  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line: string) => {
    const w = waiters.shift();
    if (w) w({ value: line, done: false });
    else buffer.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiters) w({ value: "", done: true });
    waiters.length = 0;
  });

  function pull(): Promise<IteratorResult<string>> {
    if (buffer.length > 0)
      return Promise.resolve({ value: buffer.shift()!, done: false });
    if (closed)
      return Promise.resolve({ value: "", done: true });
    return new Promise((resolve) => { waiters.push(resolve); });
  }

  return {
    send(line: string) {
      output.write(line + "\n");
    },

    close: closeFn,

    [Symbol.asyncIterator](): AsyncIterator<string> {
      return { next: pull };
    },
  };
}

export function spawnMirror(binPath: string): Transport {
  const child = spawn(binPath, [], { stdio: ["pipe", "pipe", "inherit"] });
  const stdin = child.stdin as Writable;
  const stdout = child.stdout as Readable;

  return streamTransport(stdout, stdin, () => {
    stdin.end();
    return new Promise((resolve) => {
      child.on("close", (code) => resolve(code ?? 0));
    });
  });
}

function socketClose(socket: {
  end(): void;
  destroy(): void;
  once(event: "close", cb: () => void): void;
}): () => Promise<number> {
  return () => {
    const timer = setTimeout(() => socket.destroy(), 2000);
    const done = new Promise<number>((res) => {
      socket.once("close", () => {
        clearTimeout(timer);
        res(0);
      });
    });
    socket.end();
    return done;
  };
}

export function connectMirrorTcp(options: TcpConnectOptions): Promise<Transport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: options.host, port: options.port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(streamTransport(socket, socket, socketClose(socket)));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`TCP connect to ${options.host}:${options.port} timed out`));
    });
    socket.once("error", (err) => {
      reject(new Error(`TCP connect to ${options.host}:${options.port} failed: ${err.message}`));
    });
  });
}

export function connectMirrorTls(options: TlsConnectOptions): Promise<Transport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const connectOptions: ConnectionOptions = {
    host: options.host,
    port: options.port,
    ca: options.ca,
    cert: options.cert,
    key: options.key,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    rejectUnauthorized: true,
  };
  if (options.servername !== undefined) connectOptions.servername = options.servername;

  return new Promise((resolve, reject) => {
    const socket = connectTls(connectOptions);
    socket.setTimeout(timeoutMs);
    socket.once("secureConnect", () => {
      socket.setTimeout(0);
      if (options.certSha256 !== undefined) {
        const peer = socket.getPeerCertificate();
        const actual = peer?.raw
          ? createHash("sha256").update(peer.raw).digest("hex")
          : "";
        if (normalizeFingerprint(options.certSha256) !== actual) {
          socket.destroy();
          reject(new FingerprintMismatchError(options.certSha256, actual));
          return;
        }
      }
      resolve(streamTransport(socket, socket, socketClose(socket)));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`TLS connect to ${options.host}:${options.port} timed out`));
    });
    socket.once("error", (err) => {
      reject(new Error(`TLS connect to ${options.host}:${options.port} failed: ${err.message}`));
    });
  });
}
