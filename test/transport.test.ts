import { execFile } from "node:child_process";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  connectMirrorTcp,
  connectMirrorTls,
  FingerprintMismatchError,
  type Transport,
} from "../src/transport.js";

const execFileAsync = promisify(execFile);
const GEN_CERTS = fileURLToPath(
  new URL("../scripts/gen-test-certs.sh", import.meta.url)
);

async function nextLine(t: Transport): Promise<string> {
  const { value, done } = await t[Symbol.asyncIterator]().next();
  if (done) throw new Error("transport closed");
  return value;
}

function listen(server: TcpServer | TlsServer): Promise<number> {
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no addr");
      res(addr.port);
    });
  });
}

describe("connectMirrorTcp", () => {
  let server: TcpServer;
  let port: number;

  beforeAll(async () => {
    server = createTcpServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          socket.write(line.toUpperCase() + "\n");
        }
      });
    });
    port = await listen(server);
  });

  afterAll(async () => {
    await new Promise((res) => server.close(res));
  });

  it("exchanges lines over plain TCP", async () => {
    const t = await connectMirrorTcp({ host: "127.0.0.1", port });
    t.send("hello");
    t.send("world");
    expect(await nextLine(t)).toBe("HELLO");
    expect(await nextLine(t)).toBe("WORLD");
    await t.close();
  });

  it("rejects when the port is closed", async () => {
    await expect(
      connectMirrorTcp({ host: "127.0.0.1", port: 1, timeoutMs: 1000 })
    ).rejects.toThrow(/failed/);
  });
});

describe("connectMirrorTls", () => {
  let dir: string;
  let ca: Buffer;
  let serverCertPem: Buffer;
  let serverKey: Buffer;
  let clientCert: Buffer;
  let clientKey: Buffer;
  let fingerprint: string;
  let server: TlsServer;
  let port: number;

  async function startServer(opts: { requireClientCert: boolean }) {
    server = createTlsServer(
      {
        key: serverKey,
        cert: serverCertPem,
        ca,
        requestCert: opts.requireClientCert,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
      },
      (socket) => {
        let buf = "";
        socket.on("data", (chunk) => {
          buf += chunk.toString();
          let idx;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            socket.write(line.toUpperCase() + "\n");
          }
        });
      }
    );
    port = await listen(server);
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mirrorecma-certs-"));
    await execFileAsync(GEN_CERTS, [dir]);
    ca = await readFile(join(dir, "ca.crt"));
    serverCertPem = await readFile(join(dir, "server.crt"));
    serverKey = await readFile(join(dir, "server.key"));
    clientCert = await readFile(join(dir, "client.crt"));
    clientKey = await readFile(join(dir, "client.key"));
    const raw = new X509Certificate(serverCertPem).raw;
    fingerprint = createHash("sha256").update(raw).digest("hex");
  }, 60000);

  afterEach(async () => {
    await new Promise((res) => server.close(res));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function tlsOptions(extra: Partial<Parameters<typeof connectMirrorTls>[0]> = {}) {
    return {
      host: "127.0.0.1",
      port,
      ca,
      cert: clientCert,
      key: clientKey,
      servername: "127.0.0.1",
      ...extra,
    };
  }

  it("exchanges lines over mTLS", async () => {
    await startServer({ requireClientCert: true });
    const t = await connectMirrorTls(tlsOptions());
    t.send("ping");
    expect(await nextLine(t)).toBe("PING");
    await t.close();
  });

  it("connects when the pinned fingerprint matches", async () => {
    await startServer({ requireClientCert: true });
    const t = await connectMirrorTls(tlsOptions({ certSha256: fingerprint }));
    t.send("ping");
    expect(await nextLine(t)).toBe("PING");
    await t.close();
  });

  it("accepts colon-separated uppercase fingerprints", async () => {
    await startServer({ requireClientCert: true });
    const colonFp = fingerprint
      .toUpperCase()
      .match(/../g)!
      .join(":");
    const t = await connectMirrorTls(tlsOptions({ certSha256: colonFp }));
    await t.close();
  });

  it("rejects on fingerprint mismatch", async () => {
    await startServer({ requireClientCert: true });
    await expect(
      connectMirrorTls(tlsOptions({ certSha256: "0".repeat(64) }))
    ).rejects.toThrow(FingerprintMismatchError);
  });

  it("fails the handshake without a client certificate", async () => {
    await startServer({ requireClientCert: true });
    await expect(
      connectMirrorTls({
        host: "127.0.0.1",
        port,
        ca,
        cert: Buffer.alloc(0),
        key: Buffer.alloc(0),
        servername: "127.0.0.1",
      } as Parameters<typeof connectMirrorTls>[0])
    ).rejects.toThrow();
  });
});
