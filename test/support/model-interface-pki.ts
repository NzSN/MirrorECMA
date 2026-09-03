import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { TlsOptions } from "../../src/transport.js";

const execFileAsync = promisify(execFile);

export interface ModelInterfacePki {
  readonly dir: string;
  readonly caCrt: string;
  readonly serverCrt: string;
  readonly serverKey: string;
  readonly clientCrt: string;
  readonly clientKey: string;
  readonly clientFingerprint: string;
}

async function runOpenSsl(dir: string, args: readonly string[]): Promise<void> {
  await execFileAsync("openssl", [...args], { cwd: dir });
}

async function certificateFingerprint(path: string): Promise<string> {
  const pem = await readFile(path, "utf8");
  return createHash("sha256")
    .update(new X509Certificate(pem).raw)
    .digest("hex");
}

/** Generate a minimal throwaway CA, server leaf, and client leaf for the
 * model-interface authorization scenarios. No generated credential leaves
 * the returned temporary directory. */
export async function createModelInterfacePki(): Promise<ModelInterfacePki> {
  const dir = await mkdtemp(resolve(tmpdir(), "mirrorecma-model-interface-pki-"));
  const path = (name: string) => resolve(dir, name);

  try {
    await runOpenSsl(dir, [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "ca.key", "-out", "ca.crt", "-days", "30",
      "-subj", "/CN=MirrorECMA Model Interface Test CA",
    ]);

    await writeFile(path("server.ext"), [
      "subjectAltName=IP:127.0.0.1",
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"));
    await runOpenSsl(dir, [
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "server.key", "-out", "server.csr",
      "-subj", "/CN=127.0.0.1",
    ]);
    await runOpenSsl(dir, [
      "x509", "-req", "-in", "server.csr",
      "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
      "-out", "server.crt", "-days", "30", "-extfile", "server.ext",
    ]);

    await writeFile(path("client.ext"), [
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=clientAuth",
      "",
    ].join("\n"));
    await runOpenSsl(dir, [
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "client.key", "-out", "client.csr",
      "-subj", "/CN=mirrorecma-model-interface-client",
    ]);
    await runOpenSsl(dir, [
      "x509", "-req", "-in", "client.csr",
      "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
      "-out", "client.crt", "-days", "30", "-extfile", "client.ext",
    ]);

    for (const key of ["ca.key", "server.key", "client.key"]) {
      await chmod(path(key), 0o600);
    }

    return {
      dir,
      caCrt: path("ca.crt"),
      serverCrt: path("server.crt"),
      serverKey: path("server.key"),
      clientCrt: path("client.crt"),
      clientKey: path("client.key"),
      clientFingerprint: await certificateFingerprint(path("client.crt")),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export function modelInterfaceTlsOptions(pki: ModelInterfacePki): TlsOptions {
  return {
    caPath: pki.caCrt,
    certPath: pki.clientCrt,
    keyPath: pki.clientKey,
  };
}

export async function removeModelInterfacePki(pki: ModelInterfacePki): Promise<void> {
  await rm(pki.dir, { recursive: true, force: true });
}
