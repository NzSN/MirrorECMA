import {
  parseServiceEntry,
  discoverMirrors,
  registryEndpoint,
  type MirrorServiceInfo,
} from "../src/registry.js";

const HEX64 = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
const LOW_HEX64 = HEX64.toLowerCase();

describe("parseServiceEntry", () => {
  it("parses a valid Consul entry with lowercased certSha256", () => {
    const raw = {
      Service: {
        ID: "mirror-a",
        Address: "10.0.0.5",
        Port: 8999,
        Meta: { "cert-sha256": HEX64 },
      },
    };
    expect(parseServiceEntry(raw)).toEqual({
      id: "mirror-a",
      host: "10.0.0.5",
      port: 8999,
      certSha256: LOW_HEX64,
    });
  });

  it("trims whitespace from Address, and ID defaults to empty", () => {
    const raw = {
      Service: { Address: "  10.0.0.6  ", Port: 9000 },
    };
    const parsed = parseServiceEntry(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.host).toBe("10.0.0.6");
    expect(parsed!.id).toBe("");
    expect(parsed!.certSha256).toBeUndefined();
  });

  it("returns certSha256 undefined when Meta is missing", () => {
    const raw = { Service: { ID: "m", Address: "10.0.0.7", Port: 8999 } };
    expect(parseServiceEntry(raw)).toEqual({
      id: "m",
      host: "10.0.0.7",
      port: 8999,
      certSha256: undefined,
    });
  });

  it("returns certSha256 undefined when Meta has no cert-sha256 key", () => {
    const raw = {
      Service: { Address: "10.0.0.7", Port: 8999, Meta: { other: "x" } },
    };
    const parsed = parseServiceEntry(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.certSha256).toBeUndefined();
  });

  it("accepts boundary ports 1 and 65535", () => {
    expect(parseServiceEntry({ Service: { Address: "h", Port: 1 } })?.port).toBe(1);
    expect(parseServiceEntry({ Service: { Address: "h", Port: 65535 } })?.port).toBe(65535);
  });

  describe("skips entries with missing/empty Address", () => {
    it.each([
      ["missing", { Service: { Port: 8999 } }],
      ["empty string", { Service: { Address: "", Port: 8999 } }],
      ["whitespace only", { Service: { Address: "   ", Port: 8999 } }],
      ["non-string Address", { Service: { Address: 42, Port: 8999 } }],
    ])("%s", (_label, raw) => {
      expect(parseServiceEntry(raw)).toBeNull();
    });
  });

  describe("skips entries with invalid Port", () => {
    it.each([
      ["missing", { Service: { Address: "h" } }],
      ["zero", { Service: { Address: "h", Port: 0 } }],
      ["negative", { Service: { Address: "h", Port: -1 } }],
      ["above 65535", { Service: { Address: "h", Port: 65536 } }],
      ["large", { Service: { Address: "h", Port: 70000 } }],
      ["non-integer", { Service: { Address: "h", Port: 1.5 } }],
      ["NaN", { Service: { Address: "h", Port: Number.NaN } }],
      ["Infinity", { Service: { Address: "h", Port: Number.POSITIVE_INFINITY } }],
      ["numeric string", { Service: { Address: "h", Port: "8999" } }],
    ])("%s", (_label, raw) => {
      expect(parseServiceEntry(raw)).toBeNull();
    });
  });

  describe("skips entries with malformed cert-sha256", () => {
    const base = { Service: { Address: "10.0.0.5", Port: 8999 } };
    it.each([
      ["short hex", { ...base, Service: { ...base.Service, Meta: { "cert-sha256": "abc" } } }],
      ["63 chars", { ...base, Service: { ...base.Service, Meta: { "cert-sha256": "a".repeat(63) } } }],
      ["65 chars", { ...base, Service: { ...base.Service, Meta: { "cert-sha256": "a".repeat(65) } } }],
      ["non-hex char", { ...base, Service: { ...base.Service, Meta: { "cert-sha256": "g" + "0".repeat(63) } } }],
      ["non-string value", { ...base, Service: { ...base.Service, Meta: { "cert-sha256": 123 } } }],
    ])("%s", (_label, raw) => {
      expect(parseServiceEntry(raw)).toBeNull();
    });
  });

  it("accepts mixed-case cert-sha256 and normalizes to lowercase", () => {
    const mixed = "aBcDeF0123456789".repeat(4);
    const raw = {
      Service: { Address: "10.0.0.5", Port: 8999, Meta: { "cert-sha256": mixed } },
    };
    expect(parseServiceEntry(raw)?.certSha256).toBe(mixed.toLowerCase());
  });

  describe("skips malformed top-level entries", () => {
    it.each([
      ["null", null],
      ["array", []],
      ["string", "foo"],
      ["number", 42],
      ["Service missing", { Node: {} }],
      ["Service null", { Service: null }],
      ["Service as array", { Service: [] }],
    ])("%s", (_label, raw) => {
      expect(parseServiceEntry(raw)).toBeNull();
    });
  });
});

describe("registryEndpoint", () => {
  it("normalizes a missing trailing slash", () => {
    expect(registryEndpoint("http://consul.local:8500", "v1/health/service/modelmirrors?passing=true").href)
      .toBe("http://consul.local:8500/v1/health/service/modelmirrors?passing=true");
    expect(registryEndpoint("http://consul.local:8500/", "v1/health/service/modelmirrors?passing=true").href)
      .toBe("http://consul.local:8500/v1/health/service/modelmirrors?passing=true");
  });

  it("accepts a URL instance", () => {
    expect(registryEndpoint(new URL("http://consul.local:8500"), "v1/health").href)
      .toBe("http://consul.local:8500/v1/health");
  });

  it("keeps a registry prefix path", () => {
    expect(registryEndpoint("http://consul.local:8500/consul", "/v1/health").href)
      .toBe("http://consul.local:8500/consul/v1/health");
  });
});

describe("discoverMirrors", () => {
  const validEntry = {
    Service: {
      ID: "mirror-a",
      Address: "10.0.0.5",
      Port: 8999,
      Meta: { "cert-sha256": HEX64 },
    },
  };

  function okResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }

  function badStatusResponse(status: number): Response {
    return {
      ok: false,
      status,
      json: async () => {
        throw new Error("should not be called");
      },
    } as unknown as Response;
  }

  function malformedJsonResponse(): Response {
    return {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token } in JSON");
      },
    } as unknown as Response;
  }

  /** Injectable fetch that records its calls (the suite avoids jest.fn globally). */
  function capturingFetch(response: Response) {
    const captured = { calls: 0, url: undefined as unknown, init: undefined as unknown };
    const mock = async (url: unknown, init?: unknown): Promise<Response> => {
      captured.calls += 1;
      captured.url = url;
      captured.init = init;
      return response;
    };
    return { captured, mock };
  }

  it("parses a valid registry response, preserving order", async () => {
    const { mock } = capturingFetch(okResponse([validEntry]));
    const services: MirrorServiceInfo[] = await discoverMirrors("http://consul.local:8500", {
      fetch: mock,
    });
    expect(services).toEqual([
      { id: "mirror-a", host: "10.0.0.5", port: 8999, certSha256: LOW_HEX64 },
    ]);
  });

  it("skips invalid entries and keeps valid ones", async () => {
    const { mock } = capturingFetch(
      okResponse([
        validEntry,
        { Service: { Address: "", Port: 8999 } },
        { Service: { Address: "10.0.0.9", Port: 0 } },
        { Service: { Address: "10.0.0.10", Port: 8999, Meta: { "cert-sha256": "zz" } } },
      ]),
    );
    const services = await discoverMirrors("http://consul.local:8500", { fetch: mock });
    expect(services).toHaveLength(1);
    expect(services[0].host).toBe("10.0.0.5");
  });

  it("returns [] for a non-array top-level response", async () => {
    const { mock } = capturingFetch(okResponse({ Service: validEntry.Service }));
    await expect(discoverMirrors("http://consul.local:8500", { fetch: mock })).resolves.toEqual([]);
  });

  it("returns [] for malformed JSON", async () => {
    const { mock } = capturingFetch(malformedJsonResponse());
    await expect(discoverMirrors("http://consul.local:8500", { fetch: mock })).resolves.toEqual([]);
  });

  it("returns [] for a non-2xx response", async () => {
    const { mock } = capturingFetch(badStatusResponse(500));
    await expect(discoverMirrors("http://consul.local:8500", { fetch: mock })).resolves.toEqual([]);
  });

  it("returns [] when fetch rejects (network error)", async () => {
    const mock = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    await expect(discoverMirrors("http://consul.local:8500", { fetch: mock })).resolves.toEqual([]);
  });

  it("calls fetch with the expected endpoint and Accept header", async () => {
    const { captured, mock } = capturingFetch(okResponse([validEntry]));
    await discoverMirrors("http://consul.local:8500", { fetch: mock });

    expect(captured.calls).toBe(1);
    expect(String(captured.url)).toBe(
      "http://consul.local:8500/v1/health/service/modelmirrors?passing=true",
    );
    const headers = (captured.init as { headers: Record<string, string> }).headers;
    expect(headers.Accept).toBe("application/json");
  });

  it("uses the same endpoint base URL with and without a trailing slash", async () => {
    const withSlash = capturingFetch(okResponse([]));
    const withoutSlash = capturingFetch(okResponse([]));
    await discoverMirrors("http://consul.local:8500", { fetch: withoutSlash.mock });
    await discoverMirrors("http://consul.local:8500/", { fetch: withSlash.mock });

    expect(String(withSlash.captured.url)).toBe(String(withoutSlash.captured.url));
    expect(String(withSlash.captured.url)).toBe(
      "http://consul.local:8500/v1/health/service/modelmirrors?passing=true",
    );
  });
});