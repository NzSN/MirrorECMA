import { discoverServices } from "../src/discovery.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  globalThis.fetch = (async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as typeof fetch;
}

function mockFetchThrow(err: unknown) {
  globalThis.fetch = (async () => {
    throw err;
  }) as typeof fetch;
}

describe("discoverServices", () => {
  it("parses healthy service entries", async () => {
    mockFetch([
      {
        Node: { Address: "10.0.0.1" },
        Service: {
          Address: "mirror1.example.com",
          Port: 7777,
          Meta: { "cert-sha256": "ab12cd" },
        },
      },
      {
        Node: { Address: "10.0.0.2" },
        Service: { Address: "mirror2.example.com", Port: 7778 },
      },
    ]);
    const services = await discoverServices("http://localhost:8500");
    expect(services).toEqual([
      { address: "mirror1.example.com", port: 7777, certSha256: "ab12cd" },
      { address: "mirror2.example.com", port: 7778 },
    ]);
  });

  it("falls back to Node.Address when Service.Address is empty", async () => {
    mockFetch([
      { Node: { Address: "10.0.0.1" }, Service: { Address: "", Port: 7777 } },
    ]);
    const services = await discoverServices("http://localhost:8500");
    expect(services).toEqual([{ address: "10.0.0.1", port: 7777 }]);
  });

  it("queries the passing health endpoint for the given service name", async () => {
    let requested = "";
    globalThis.fetch = (async (url: unknown) => {
      requested = String(url);
      return { ok: true, status: 200, json: async () => [] };
    }) as typeof fetch;
    await discoverServices("http://consul:8500/", { serviceName: "mirror" });
    expect(requested).toBe(
      "http://consul:8500/v1/health/service/mirror?passing=true"
    );
  });

  it("returns [] on non-2xx responses", async () => {
    mockFetch({}, { ok: false, status: 500 });
    expect(await discoverServices("http://localhost:8500")).toEqual([]);
  });

  it("returns [] on network errors", async () => {
    mockFetchThrow(new Error("connection refused"));
    expect(await discoverServices("http://localhost:8500")).toEqual([]);
  });

  it("returns [] on malformed JSON bodies", async () => {
    mockFetch({ not: "an array" });
    expect(await discoverServices("http://localhost:8500")).toEqual([]);
  });

  it("skips entries missing address or port", async () => {
    mockFetch([
      { Node: {}, Service: { Address: "", Port: 7777 } },
      { Node: { Address: "10.0.0.1" }, Service: { Address: "a", Port: "x" } },
      { Service: null },
      "garbage",
      { Node: { Address: "10.0.0.2" }, Service: { Address: "b", Port: 1 } },
    ]);
    expect(await discoverServices("http://localhost:8500")).toEqual([
      { address: "b", port: 1 },
    ]);
  });

  it("returns [] when the request times out", async () => {
    globalThis.fetch = ((url: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      })) as typeof fetch;
    expect(
      await discoverServices("http://localhost:8500", { timeoutMs: 20 })
    ).toEqual([]);
  });
});
