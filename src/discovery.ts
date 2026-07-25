export interface ServiceInfo {
  address: string;
  port: number;
  certSha256?: string;
}

export interface DiscoverOptions {
  serviceName?: string;
  timeoutMs?: number;
}

const DEFAULT_SERVICE_NAME = "modelmirrors";
const DEFAULT_TIMEOUT_MS = 5000;

interface ConsulHealthEntry {
  Node?: { Address?: unknown };
  Service?: {
    Address?: unknown;
    Port?: unknown;
    Meta?: unknown;
  };
}

function parseEntry(entry: ConsulHealthEntry): ServiceInfo | null {
  const svc = entry.Service;
  if (!svc) return null;
  const address =
    typeof svc.Address === "string" && svc.Address !== ""
      ? svc.Address
      : typeof entry.Node?.Address === "string" && entry.Node.Address !== ""
        ? entry.Node.Address
        : null;
  if (address === null) return null;
  if (typeof svc.Port !== "number" || !Number.isInteger(svc.Port)) return null;

  let certSha256: string | undefined;
  if (svc.Meta !== null && typeof svc.Meta === "object") {
    const fp = (svc.Meta as Record<string, unknown>)["cert-sha256"];
    if (typeof fp === "string" && fp !== "") certSha256 = fp;
  }

  const info: ServiceInfo = { address, port: svc.Port };
  if (certSha256 !== undefined) info.certSha256 = certSha256;
  return info;
}

export async function discoverServices(
  registryUrl: string,
  options: DiscoverOptions = {}
): Promise<ServiceInfo[]> {
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = registryUrl.replace(/\/+$/, "");
  const url = `${base}/v1/health/service/${encodeURIComponent(serviceName)}?passing=true`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    const out: ServiceInfo[] = [];
    for (const entry of body) {
      if (entry === null || typeof entry !== "object") continue;
      const info = parseEntry(entry as ConsulHealthEntry);
      if (info) out.push(info);
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
