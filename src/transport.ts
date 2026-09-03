import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import * as net from "node:net";
import * as tls from "node:tls";

export interface Transport {
  send(line: string): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
  close(): Promise<number>;
  /** Session model of this transport: stdio mirrors are sync-only;
   *  network mirrors (--serve/--server) also accept async job messages.
   *  Set by the transport constructors; used by Connection to reject
   *  async operations on stdio before any bytes are sent. */
  readonly mode?: "stdio" | "network";
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

/** Maximum UTF-8 JSON payload size. The trailing LF makes the complete
 * JSONL record at most 64 KiB, matching the client guide's safe ceiling. */
export const MAX_PROTOCOL_LINE_BYTES = 65_535;

/** Validate one outbound protocol payload before any transport bytes flow. */
export function validateProtocolLine(line: string): void {
  if (line.length === 0) throw new Error("protocol line must not be empty");
  if (line.includes("\n"))
    throw new Error("protocol line contains an embedded newline");
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_PROTOCOL_LINE_BYTES) {
    throw new Error(
      `protocol line is ${bytes} UTF-8 bytes; maximum is ${MAX_PROTOCOL_LINE_BYTES}`,
    );
  }
}

function lineIterator() {
  const buffer: string[] = [];
  const waiters: Array<{
    resolve: (v: IteratorResult<string>) => void;
    reject: (reason: Error) => void;
  }> = [];
  let closed = false;
  let failure: Error | undefined;

  const emit = (line: string) => {
    const w = waiters.shift();
    if (w) w.resolve({ value: line, done: false });
    else buffer.push(line);
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const w of waiters) w.resolve({ value: "", done: true });
    waiters.length = 0;
  };
  const fail = (err: Error) => {
    if (closed) return;
    closed = true;
    failure = err;
    buffer.length = 0;
    for (const w of waiters) w.reject(err);
    waiters.length = 0;
  };
  const pull = (): Promise<IteratorResult<string>> => {
    if (failure) return Promise.reject(failure);
    if (buffer.length > 0)
      return Promise.resolve({ value: buffer.shift()!, done: false });
    if (closed)
      return Promise.resolve({ value: "", done: true });
    return new Promise((resolve, reject) => { waiters.push({ resolve, reject }); });
  };

  return { emit, finish, fail, pull };
}

/**
 * Attach the protocol's bounded byte-level JSONL framing to a readable stream.
 *
 * Every protocol record must be LF-terminated. CRLF is normalized to the
 * payload without CR, but EOF with pending bytes is a fatal framing error.
 */
function attachProtocolFraming(
  input: Readable,
  sink: ReturnType<typeof lineIterator>,
  onFatal: () => void | Promise<unknown>,
): void {
  let pending = Buffer.alloc(0);
  let terminal = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const framingError = (message: string): Error =>
    new Error(`protocol framing error: ${message}`);

  const stop = (err: Error) => {
    if (terminal) return;
    terminal = true;
    sink.fail(err);
    input.removeListener("data", onData);
    input.removeListener("end", onEnd);
    input.removeListener("close", onClose);
    void Promise.resolve().then(onFatal).catch(() => {});
  };

  const decodePayload = (rawPayload: Buffer): string => {
    const payload =
      rawPayload.length > 0 && rawPayload[rawPayload.length - 1] === 0x0d
        ? rawPayload.subarray(0, rawPayload.length - 1)
        : rawPayload;
    if (payload.length > MAX_PROTOCOL_LINE_BYTES) {
      throw framingError(
        `protocol line is ${payload.length} UTF-8 bytes; maximum is ${MAX_PROTOCOL_LINE_BYTES}`,
      );
    }
    try {
      return decoder.decode(payload);
    } catch (err) {
      throw new Error("protocol framing error: protocol line is not valid UTF-8", {
        cause: err,
      });
    }
  };

  const appendPrefix = (part: Buffer) => {
    const total = pending.length + part.length;
    // One extra byte is provisionally permitted only when it is the CR of a
    // CRLF terminator. This keeps the retained accumulator strictly bounded.
    const last = part.length > 0 ? part[part.length - 1] : pending[pending.length - 1];
    if (
      total > MAX_PROTOCOL_LINE_BYTES + 1 ||
      (total > MAX_PROTOCOL_LINE_BYTES && last !== 0x0d)
    ) {
      throw framingError(
        `protocol line exceeds ${MAX_PROTOCOL_LINE_BYTES} UTF-8 bytes`,
      );
    }
    if (part.length > 0) pending = Buffer.concat([pending, part], total);
  };

  function onData(chunk: Buffer | Uint8Array | string): void {
    if (terminal) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    const completed: string[] = [];
    try {
      let offset = 0;
      for (;;) {
        const newline = bytes.indexOf(0x0a, offset);
        if (newline < 0) {
          appendPrefix(bytes.subarray(offset));
          break;
        }
        const part = bytes.subarray(offset, newline);
        // Validate the completed payload without first retaining an
        // attacker-sized segment.
        const rawLength = pending.length + part.length;
        const endsInCr =
          part.length > 0
            ? part[part.length - 1] === 0x0d
            : pending.length > 0 && pending[pending.length - 1] === 0x0d;
        const payloadLength = rawLength - (endsInCr ? 1 : 0);
        if (payloadLength > MAX_PROTOCOL_LINE_BYTES) {
          throw framingError(
            `protocol line is ${payloadLength} UTF-8 bytes; maximum is ${MAX_PROTOCOL_LINE_BYTES}`,
          );
        }
        if (part.length > 0) pending = Buffer.concat([pending, part], rawLength);
        completed.push(decodePayload(pending));
        pending = Buffer.alloc(0);
        offset = newline + 1;
        if (offset === bytes.length) break;
      }
      // A readable may coalesce several protocol records into one data event.
      // Publish none of them until that entire event has passed framing checks,
      // so a fatal trailing record cannot race earlier messages into replay.
      for (const line of completed) sink.emit(line);
    } catch (err) {
      stop(err instanceof Error ? err : framingError(String(err)));
    }
  }

  function onEnd(): void {
    if (terminal) return;
    if (pending.length > 0) {
      stop(framingError("protocol line is not terminated by LF before EOF"));
      return;
    }
    terminal = true;
    sink.finish();
  }

  // Preserve the old transport contract for underlying I/O failures: they
  // appear as iterator closure. Only a framing violation rejects iteration.
  function onStreamError(): void {
    onClose();
  }

  function onClose(): void {
    if (terminal) return;
    terminal = true;
    pending = Buffer.alloc(0);
    sink.finish();
  }

  input.on("data", onData);
  input.once("end", onEnd);
  input.once("close", onClose);
  input.once("error", onStreamError);
}

/**
 * Create the async line iterator used by every inbound transport. Exported for
 * transport conformance tests, but not re-exported by the package barrel.
 */
export function protocolLineIterator(
  input: Readable,
  onFatal: () => void | Promise<unknown>,
): AsyncIterator<string> {
  const sink = lineIterator();
  attachProtocolFraming(input, sink, onFatal);
  return { next: sink.pull };
}

function onceCloser(close: () => Promise<number>): () => Promise<number> {
  let result: Promise<number> | undefined;
  return () => result ??= close();
}

export function spawnMirror(binPath: string): Transport {
  const child = spawn(binPath, [], { stdio: ["pipe", "pipe", "inherit"] });
  const stdin = child.stdin as Writable;
  const stdout = child.stdout as Readable;

  const exited = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 0));
  });
  const close = onceCloser(async () => {
    stdin.end();
    // A wedged mirror must not pin the client's event loop: if it
    // does not exit promptly after stdin closes, terminate it.
    const killer = setTimeout(() => child.kill("SIGTERM"), 2_000);
    const code = await exited;
    clearTimeout(killer);
    return code;
  });
  const it = protocolLineIterator(stdout, close);

  return {
    mode: "stdio" as const,

    send(line: string) {
      validateProtocolLine(line);
      stdin.write(line + "\n");
    },

    async close(): Promise<number> {
      return close();
    },

    [Symbol.asyncIterator](): AsyncIterator<string> {
      return it;
    },
  };
}

export interface ConnectTransport extends Transport {
  /** Resolves once the TCP connection is established; rejects on connect error. */
  ready: Promise<void>;
}

export function connectMirror(host: string, port: number): ConnectTransport {
  const sock = net.createConnection({ host, port });
  const close = onceCloser(async () => {
    sock.end();
    sock.destroy();
    return 0;
  });

  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    sock.once("connect", () => {
      // Swallow post-connect errors so they surface as iterator closure,
      // not as unhandled 'error' events.
      sock.on("error", () => {});
      resolvePromise();
    });
    sock.once("error", rejectPromise);
  });

  const it = protocolLineIterator(sock, close);

  return {
    mode: "network" as const,

    ready,

    send(line: string) {
      validateProtocolLine(line);
      sock.write(line + "\n");
    },

    async close(): Promise<number> {
      return close();
    },

    [Symbol.asyncIterator](): AsyncIterator<string> {
      return it;
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
  const verifyName = opts.servername ?? host;

  const sock = tls.connect({
    host,
    port,
    servername: net.isIP(verifyName) ? undefined : verifyName,
    ca,
    cert,
    key,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname, cert) => {
      try {
        const x509 = new X509Certificate(cert.raw);
        const matched = net.isIP(verifyName)
          ? x509.checkIP(verifyName)
          : x509.checkHost(verifyName, { subject: "never" });
        if (matched !== undefined) return undefined;
        return new Error(
          `server identity ${verifyName} is not present in the certificate SAN`,
        );
      } catch (err) {
        return err instanceof Error
          ? err
          : new Error(`cannot verify server SAN for ${verifyName}`);
      }
    },
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
  const close = onceCloser(async () => {
    if (sock.destroyed) return 0;
    const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
    sock.end();
    await Promise.race([closed, new Promise((r) => setTimeout(r, 1_000))]);
    if (!sock.destroyed) sock.destroy();
    return 0;
  });
  sock.on("error", () => {}); // post-handshake errors surface as iterator close
  const it = protocolLineIterator(sock, close);

  return {
    mode: "network" as const,

    peerFingerprint,
    send(line: string) {
      validateProtocolLine(line);
      sock.write(line + "\n");
    },
    async close(): Promise<number> {
      return close();
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return it;
    },
  };
}
