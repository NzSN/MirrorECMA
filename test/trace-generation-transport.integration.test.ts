import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jest } from "@jest/globals";

import {
  Connection,
  connectMirror,
  connectTlsMirror,
  runClientGenTraces,
  type ApalacheConfig,
  type Transport,
} from "../src/index.js";
import {
  createModelInterfacePki,
  modelInterfaceTlsOptions,
  removeModelInterfacePki,
  type ModelInterfacePki,
} from "./support/model-interface-pki.js";

const MIRROR_BIN = process.env.TG4_MIRROR_BIN;
const FAKE_APALACHE = process.env.TG4_FAKE_APALACHE;
const realTest = MIRROR_BIN && FAKE_APALACHE ? it : it.skip;
const STDIO_MIRROR = resolve("test/fixtures/trace-generation-mirror.sh");

const config: ApalacheConfig = {
  specPath: "Synthetic.tla",
  invariant: "Inv",
  lengthBound: 1,
};
const traces = { numTraces: 1 } as const;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port assigned");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitForTcp(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const probe = connectMirror("127.0.0.1", port);
    try {
      await probe.ready;
      await probe.close();
      return;
    } catch {
      await probe.close().catch(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error("mirror TCP server did not become ready");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function spawnServer(args: string[], countFile: string): ChildProcess {
  return spawn(MIRROR_BIN!, args, {
    env: {
      ...process.env,
      APALACHE_MC: FAKE_APALACHE,
      FAKE_APALACHE_COUNT_FILE: countFile,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function expectTooLarge(target: Transport, destPath: string | null): Promise<void> {
  await expect(runClientGenTraces(target, config, destPath, traces)).rejects.toThrow(
    /TRACE_RESULT_TOO_LARGE/,
  );
}

async function invocationCount(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe("real trace-generation result delivery", () => {
  jest.setTimeout(120_000);

  realTest("stdio returns durable paths that the public client can consume", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "mirrorecma-tg4-stdio-"));
    try {
      const result = await runClientGenTraces(STDIO_MIRROR, config, scratch, traces);
      expect(result.itfTraces).toEqual([]);
      expect(result.itfTracePaths).toHaveLength(1);
      expect((await stat(result.itfTracePaths[0]!)).isFile()).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  realTest("stdio without a durable destination fails promptly", async () => {
    await expect(runClientGenTraces(STDIO_MIRROR, config, null, traces)).rejects.toThrow(
      /TRACE_RESULT_TOO_LARGE/,
    );
  });

  realTest("TCP rejects oversized sync and async results and remains usable", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "mirrorecma-tg4-tcp-"));
    const countFile = join(scratch, "calls");
    await writeFile(countFile, "");
    const port = await freePort();
    const child = spawnServer(["--serve", String(port), "--jobs", "2"], countFile);
    try {
      await waitForTcp(port);
      await expectTooLarge(connectMirror("127.0.0.1", port), scratch);
      await expectTooLarge(connectMirror("127.0.0.1", port), scratch);

      const connection = await Connection.open(connectMirror("127.0.0.1", port));
      try {
        const before = await invocationCount(countFile);
        const handle = await connection.submitTraceGenAsync(config, traces, { destPath: scratch });
        const first = await handle.await(30);
        expect(first.done).toBe(true);
        if (!first.done) throw new Error("oversized async job did not terminate");
        expect(first.result.jobId).toBe(handle.jobId);
        expect(first.result.outcome).toEqual({
          error: expect.stringMatching(/^TRACE_RESULT_TOO_LARGE:/),
        });
        const queried = await handle.query();
        const repeated = await handle.await(30);
        expect(queried).toEqual(first.result);
        expect(repeated).toEqual(first);
        expect(await invocationCount(countFile)).toBe(before + 1);
      } finally {
        await connection.close();
      }
    } finally {
      await stop(child);
      await rm(scratch, { recursive: true, force: true });
    }
  });

  realTest("mTLS rejects oversized results and remains usable", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "mirrorecma-tg4-tls-"));
    const countFile = join(scratch, "calls");
    const pki: ModelInterfacePki = await createModelInterfacePki();
    const port = await freePort();
    const child = spawnServer([
      "--server", String(port), "--tls", "--jobs", "2",
      "--cert", pki.serverCrt, "--key", pki.serverKey, "--ca", pki.caCrt,
    ], countFile);
    const target = () => connectTlsMirror("127.0.0.1", port, modelInterfaceTlsOptions(pki));
    try {
      await waitForTcp(port);
      await expectTooLarge(target(), scratch);
      await expectTooLarge(target(), scratch);
    } finally {
      await stop(child);
      await removeModelInterfacePki(pki);
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
