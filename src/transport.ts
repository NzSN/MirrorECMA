import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";

export interface Transport {
  send(line: string): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
  close(): Promise<number>;
}

export function spawnMirror(binPath: string): Transport {
  const child = spawn(binPath, [], { stdio: ["pipe", "pipe", "inherit"] });
  const stdin = child.stdin as Writable;
  const stdout = child.stdout as Readable;

  const buffer: string[] = [];
  const waiters: ((v: IteratorResult<string>) => void)[] = [];
  let closed = false;

  const rl = createInterface({ input: stdout, crlfDelay: Infinity });
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
      stdin.write(line + "\n");
    },

    async close(): Promise<number> {
      stdin.end();
      return new Promise((resolve) => {
        child.on("close", (code) => resolve(code ?? 0));
      });
    },

    [Symbol.asyncIterator](): AsyncIterator<string> {
      return { next: pull };
    },
  };
}
