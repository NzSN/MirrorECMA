import {
  connectTlsMirror,
  type TlsConnectTransport,
  type TlsOptions,
} from "./transport.js";

/** A single mirror candidate parsed from a Consul health response. */
export interface MirrorServiceInfo {
  /** Consul service ID; defaults to "" if the registry omitted it. */
  id: string;
  host: string;
  port: number;
  /** SHA-256 of the server leaf cert from Consul Meta, if advertised. */
  certSha256?: string;
}

export interface RegistryOptions {
  /** HTTP request timeout. Default 5 000 ms. */
  timeoutMs?: number;
  /** Test seam: injectable fetch (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface RegistryConnectOptions extends RegistryOptions {
  /** Explicit pin override; wins over each entry's certSha256. */
  pin?: string;
}

/**
 * Join a registry base URL with a relative path. Normalizes a missing trailing
 * slash on the base before resolving, and strips a leading "/" from the path so
 * it never discards a registry prefix path (e.g. `/consul/v1/...` stays under
 * the prefix rather than jumping back to the origin root).
 */
export function registryEndpoint(base: string | URL, path: string): URL {
  const baseStr = base instanceof URL ? base.href : base;
  const normalized = baseStr.endsWith("/") ? baseStr : baseStr + "/";
  const rel = path.startsWith("/") ? path.slice(1) : path;
  return new URL(rel, normalized);
}

/**
 * Parse one element of a Consul health response into a mirror candidate.
 * Total: returns null for anything malformed, never throws.
 *
 * - `Service` must be an object.
 * - `Service.Address` must be non-empty after trimming.
 * - `Service.Port` must be a finite safe integer in 1..65535.
 * - `Service.Meta["cert-sha256"]`, when present, must be 64 hex chars
 *   (case-insensitive); it is normalized to lowercase. A malformed present
 *   value skips the entry (no unpinned fallback); absent is allowed.
 * - `Service.ID` defaults to "" if missing (not used by connect logic).
 */
export function parseServiceEntry(raw: unknown): MirrorServiceInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const svc = entry["Service"];
  if (typeof svc !== "object" || svc === null) return null;
  const service = svc as Record<string, unknown>;

  const address = typeof service["Address"] === "string" ? service["Address"].trim() : "";
  if (address === "") return null;

  const port = service["Port"];
  if (
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null;
  }

  let certSha256: string | undefined;
  const meta = service["Meta"];
  if (typeof meta === "object" && meta !== null) {
    const rawPin = (meta as Record<string, unknown>)["cert-sha256"];
    if (rawPin !== undefined) {
      if (typeof rawPin !== "string" || !/^[0-9a-fA-F]{64}$/.test(rawPin)) {
        return null;
      }
      certSha256 = rawPin.toLowerCase();
    }
  }

  const id = typeof service["ID"] === "string" ? service["ID"] : "";

  return { id, host: address, port, certSha256 };
}

/**
 * Discover mirror candidates from a Consul-compatible registry.
 *
 * GET <registryUrl>/v1/health/service/modelmirrors?passing=true and parse the
 * `Service` subset. Fails closed: any network error, non-2xx response, JSON
 * parse error, or non-array top level resolves to `[]` — never throws.
 * Order is preserved; entries are not deduplicated.
 */
export async function discoverMirrors(
  registryUrl: string | URL,
  opts: RegistryOptions = {},
): Promise<MirrorServiceInfo[]> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const endpoint = registryEndpoint(
      registryUrl,
      "v1/health/service/modelmirrors?passing=true",
    );
    const res = await doFetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) return [];
    const json: unknown = await res.json();
    if (!Array.isArray(json)) return [];

    const out: MirrorServiceInfo[] = [];
    for (const el of json) {
      const parsed = parseServiceEntry(el);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Discover mirrors and connect to the first usable candidate (registry order,
 * no dedup). Each candidate is tried with `pin = opts.pin ?? certSha256`
 * (explicit pin wins); per-candidate failures are collected and reported if
 * every candidate fails. An empty registry result throws "no mirror
 * candidates discovered"; an exhausted list throws with all diagnostics.
 */
export async function connectMirrorFromRegistry(
  registryUrl: string | URL,
  tls: TlsOptions,
  opts: RegistryConnectOptions = {},
): Promise<TlsConnectTransport> {
  const url = String(registryUrl);
  const services = await discoverMirrors(registryUrl, opts);
  if (services.length === 0) {
    throw new Error(`no mirror candidates discovered from ${url}`);
  }

  const failures: string[] = [];
  for (const service of services) {
    const pin = opts.pin ?? service.certSha256;
    try {
      return await connectTlsMirror(service.host, service.port, { ...tls, pin });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${service.host}:${service.port}: ${message}`);
    }
  }

  throw new Error(
    `no usable mirror discovered from ${url}: ` + failures.join("; "),
  );
}
