import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import * as net from "node:net";

export interface Transport {
  send(line: string): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
  close(): Promise<number>;
}

function lineIterator() {
  const buffer: string[] = [];
  const waiters: ((v: IteratorResult<string>) => void)[] = [];
  let closed = false;

  const emit = (line: string) => {
    const w = waiters.shift();
    if (w) w({ value: line, done: false });
    else buffer.push(line);
  };
  const finish = () => {
    closed = true;
    for (const w of waiters) w({ value: "", done: true });
    waiters.length = 0;
  };
  const pull = (): Promise<IteratorResult<string>> => {
    if (buffer.length > 0)
      return Promise.resolve({ value: buffer.shift()!, done: false });
    if (closed)
      return Promise.resolve({ value: "", done: true });
    return new Promise((resolve) => { waiters.push(resolve); });
  };

  return { emit, finish, pull };
}

export function spawnMirror(binPath: string): Transport {
  const child = spawn(binPath, [], { stdio: ["pipe", "pipe", "inherit"] });
  const stdin = child.stdin as Writable;
  const stdout = child.stdout as Readable;

  const it = lineIterator();
  const rl = createInterface({ input: stdout, crlfDelay: Infinity });
  rl.on("line", it.emit);
  rl.on("close", it.finish);

  return {
    send(line: string) {
      stdin.write(line + "\n");
    },

    async close(): Promise<number> {
      stdin.end();
      return new Promise((resolve) => {
        child.on("close", (code) => resolve(code ?? 0));
      });
    },

    [Symbol.asyncIterator](): AsyncIterator<string> {
      return { next: it.pull };
    },
  };
}

export interface ConnectTransport extends Transport {
  /** Resolves once the TCP connection is established; rejects on connect error. */
  ready: Promise<void>;
}

export function connectMirror(host: string, port: number): ConnectTransport {
  const sock = net.createConnection({ host, port });
  const it = lineIterator();

  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    sock.once("connect", () => {
      // Swallow post-connect errors so they surface as iterator closure,
      // not as unhandled 'error' events.
      sock.on("error", () => {});
      resolvePromise();
    });
    sock.once("error", rejectPromise);
  });

  const rl = createInterface({ input: sock, crlfDelay: Infinity });
  // readline re-emits socket errors as interface 'error' events; they are
  // already surfaced via `ready` rejection / iterator closure.
  rl.on("error", () => {});
  rl.on("line", it.emit);
  rl.on("close", it.finish);
  sock.on("close", it.finish);

  return {
    ready,

    send(line: string) {
      sock.write(line + "\n");
    },

    async close(): Promise<number> {
      sock.end();
      sock.destroy();
      return 0;
    },

    [Symbol.asyncIterator](): AsyncIterator<string> {
      return { next: it.pull };
    },
  };
}
