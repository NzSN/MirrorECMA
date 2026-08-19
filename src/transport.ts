import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import * as net from "node:net";
import * as tls from "node:tls";

export interface Transport {
  send(line: string): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
  close(): Promise<number>;
}

export interface TlsOptions {
  /** PEM CA bundle used to verify the mirror's server chain. */
  caPath: string;
  /** PEM client certificate signed by the same CA. */
  certPath: string;
  /** PEM private key for certPath (must be 0600 on POSIX, like the Haskell client). */
  keyPath: string;
  /** Expected server leaf certificate fingerprint, lowercase hex SHA-256 over DER.
   *  Optional for direct connect; registry connect supplies one automatically. */
  pin?: string;
  /** SNI/hostname checked against the server SAN. Defaults to `host`. */
  servername?: string;
  /** TLS handshake + pin-check timeout. Default 10 000 ms. */
  handshakeTimeoutMs?: number;
}

export interface TlsConnectTransport extends Transport {
  /** Peer leaf certificate SHA-256 (lowercase hex), known once connect returns. */
  readonly peerFingerprint: string;
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

/**
 * Trim, lowercase, and validate a certificate fingerprint: 64 lowercase hex
 * chars. Exported for direct unit testing (not part of the public barrel API).
 */
export function normalizeFingerprint(pin: string): string {
  const normalized = pin.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`invalid certificate fingerprint: ${pin}`);
  }
  return normalized;
}

/** SHA-256 over raw bytes as lowercase hex. Exported for direct unit testing. */
export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** On POSIX the client key must not be accessible by group/other (matches Haskell). */
async function assertPrivateKeyMode(keyPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const { mode } = await stat(keyPath);
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `client key ${keyPath} must not be accessible by group/other (chmod 0600)`,
    );
  }
}

/**
 * Resolve on a successful TLS 1.3 handshake, reject on error or timeout.
 * Also rejects when the peer is unauthorized even if `secureConnect` fired
 * first (defense for Node versions that emit it before rejecting the peer).
 */
function awaitSecureConnect(
  sock: tls.TLSSocket,
  timeoutMs: number,
): Promise<tls.TLSSocket> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      rejectPromise(new Error(`TLS handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    sock.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!sock.authorized) {
        sock.destroy();
        rejectPromise(
          sock.authorizationError ?? new Error("TLS handshake failed: peer not authorized"),
        );
        return;
      }
      resolvePromise(sock);
    });
    sock.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
}

/** SHA-256 (lowercase hex) over the DER encoding of the peer leaf certificate. */
function peerLeafFingerprint(sock: tls.TLSSocket): string {
  const x509 = sock.getPeerX509Certificate();
  if (x509) return sha256Hex(x509.raw);
  const legacy = sock.getPeerCertificate();
  if (legacy && legacy.raw && legacy.raw.length > 0) return sha256Hex(legacy.raw);
  throw new Error("no peer certificate available");
}

/**
 * Connect to a mirror over TLS 1.3 mTLS. Resolves only after a successful
 * handshake (and optional fingerprint pin check); rejects on any failure.
 */
export async function connectTlsMirror(
  host: string,
  port: number,
  opts: TlsOptions,
): Promise<TlsConnectTransport> {
  await assertPrivateKeyMode(opts.keyPath);
  const [ca, cert, key] = await Promise.all([
    readFile(opts.caPath),
    readFile(opts.certPath),
    readFile(opts.keyPath),
  ]);
  const expectedPin = opts.pin ? normalizeFingerprint(opts.pin) : undefined;

  const sock = tls.connect({
    host,
    port,
    servername: opts.servername ?? host,
    ca,
    cert,
    key,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    rejectUnauthorized: true,
  });

  await awaitSecureConnect(sock, opts.handshakeTimeoutMs ?? 10_000);
  const peerFingerprint = peerLeafFingerprint(sock);
  if (expectedPin && peerFingerprint !== expectedPin) {
    sock.destroy();
    throw new Error(
      `certificate fingerprint mismatch for ${host}:${port}: expected ${expectedPin}, got ${peerFingerprint}`,
    );
  }

  // The mirror sends nothing until Register*, so framing can be attached now.
  const it = lineIterator();
  const rl = createInterface({ input: sock, crlfDelay: Infinity });
  sock.on("error", () => {}); // post-handshake errors surface as iterator close
  rl.on("error", () => {});
  rl.on("line", it.emit);
  rl.on("close", it.finish);
  sock.on("close", it.finish);

  return {
    peerFingerprint,
    send(line: string) {
      sock.write(line + "\n");
    },
    async close(): Promise<number> {
      if (sock.destroyed) return 0;
      const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
      sock.end();
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1_000))]);
      if (!sock.destroyed) sock.destroy();
      return 0;
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return { next: it.pull };
    },
  };
}
