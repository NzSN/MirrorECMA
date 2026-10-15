import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { createServer } from "node:tls";
import { connectTlsMirror, type TlsOptions } from "../src/transport.js";
import {
  createModelInterfacePki, modelInterfaceTlsOptions, removeModelInterfacePki,
  type ModelInterfacePki,
} from "./support/model-interface-pki.js";

// Run on a POSIX filesystem: these assertions require real permission/special bits.
const describePosix = process.platform === "win32" ? describe.skip : describe;
describePosix("exact POSIX client key permissions", () => {
  let directory: string;
  let pki: ModelInterfacePki;
  let ca: Buffer;
  let certificate: Buffer;
  let serverKey: Buffer;
  let privateKey: Buffer;

  beforeAll(async () => {
    pki = await createModelInterfacePki();
    directory = pki.dir;
    ca = await readFile(pki.caCrt);
    certificate = await readFile(pki.serverCrt);
    serverKey = await readFile(pki.serverKey);
    privateKey = await readFile(pki.clientKey);
  }, 20_000);

  afterAll(async () => { if (pki) await removeModelInterfacePki(pki); });

  async function withPeer(
    check: (port: number, accepted: () => number, received: Promise<string>) => Promise<void>,
  ): Promise<void> {
    let connections = 0;
    let receive!: (line: string) => void;
    const received = new Promise<string>((resolve) => { receive = resolve; });
    const sockets = new Set<Socket>();
    const server = createServer({
      key: serverKey, cert: certificate, ca,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true,
    }, (socket) => {
      let bytes = "";
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.toString("utf8");
        if (bytes.includes("\n")) receive(bytes);
      });
    });
    server.on("connection", (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    // Failed handshakes remain observable as failed client operations.
    server.on("tlsClientError", () => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected owned TCP listener");
      await check(address.port, () => connections, received);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  async function keyOptions(mode: number): Promise<TlsOptions> {
    const keyPath = join(directory, `client-${mode.toString(8)}.key`);
    await writeFile(keyPath, privateKey);
    await chmod(keyPath, mode);
    // Fail explicitly if the environment cannot establish the requested mode.
    expect((await stat(keyPath)).mode & 0o7777).toBe(mode);
    return { ...modelInterfaceTlsOptions(pki), keyPath, handshakeTimeoutMs: 2_000 };
  }

  async function unchanged(options: TlsOptions, mode: number): Promise<void> {
    expect(await readFile(options.keyPath)).toEqual(privateKey);
    expect((await stat(options.keyPath)).mode & 0o7777).toBe(mode);
  }

  it("accepts exact 0600 and exchanges a frame without changing the key", async () => {
    const options = await keyOptions(0o600);
    await withPeer(async (port, accepted, received) => {
      const transport = await connectTlsMirror("127.0.0.1", port, options);
      try {
        transport.send('{"proto_step":"cancel"}');
        await expect(received).resolves.toBe('{"proto_step":"cancel"}\n');
        expect(accepted()).toBe(1);
      } finally { await transport.close(); }
    });
    await unchanged(options, 0o600);
  });

  it.each([0o400, 0o700, 0o640, 0o644, 0o604, 0o4600, 0o2600, 0o1600])(
    "rejects mode %i before network acquisition and preserves the key", async (mode) => {
      const options = await keyOptions(mode);
      await withPeer(async (port, accepted) => {
        await expect(connectTlsMirror("127.0.0.1", port, options)).rejects.toThrow(/exact POSIX mode 0600/);
        // A second local rejection proves mode admission precedes CA/certificate reads too.
        await expect(connectTlsMirror("127.0.0.1", port, {
          ...options, caPath: join(directory, "missing-ca.crt"), certPath: join(directory, "missing-client.crt"),
        })).rejects.toThrow(/exact POSIX mode 0600/);
        expect(accepted()).toBe(0);
      });
      await unchanged(options, mode);
    },
  );
});
