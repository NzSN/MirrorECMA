import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  applyOracleModeEnvironment,
  LeaseReductionError,
  openReductionOracleTransport,
  settleOracleCleanup,
  validateLeaseReductionRemoteTools,
  validateLeaseReductionServiceIdentity,
  LEASE_REDUCTION_TOOLS_SCHEMA_REMOTE,
  type LeaseReductionServiceIdentity,
} from "../src/lease-reduction.js";
import type {
  TlsConnectTransport,
  TlsOptions,
  Transport,
} from "../src/transport.js";

const FINGERPRINT = "a".repeat(64);
const service: LeaseReductionServiceIdentity = {
  endpoint: { host: "172.20.208.1", port: 8999 },
  peerLeafSha256: FINGERPRINT,
  apalacheVersion: "0.62.2",
  javaVersion: "25.0.4+7-LTS",
  observedAt: "2026-09-29T00:00:00Z",
  qualificationRef: "operator-observation/2026-09-29",
};
const serviceRaw = JSON.parse(JSON.stringify(service));

describe("validateLeaseReductionServiceIdentity", () => {
  test("accepts a well-formed operator observation", () => {
    const validated = validateLeaseReductionServiceIdentity(serviceRaw);
    expect(validated).toEqual(service);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.endpoint)).toBe(true);
  });
  test.each([
    ["wrong Apalache version", { apalacheVersion: "0.61.0" }],
    ["wrong Java version", { javaVersion: "21.0.11" }],
    ["uppercase fingerprint", { peerLeafSha256: "A".repeat(64) }],
    ["short fingerprint", { peerLeafSha256: "ab12" }],
    ["extra key", { unexpected: true }],
    ["bad port zero", { endpoint: { host: "172.20.208.1", port: 0 } }],
    ["fractional port", { endpoint: { host: "172.20.208.1", port: 8999.5 } }],
    ["empty host", { endpoint: { host: "", port: 8999 } }],
    ["host with slash", { endpoint: { host: "a/b", port: 8999 } }],
    ["non-UTC timestamp", { observedAt: "2026-09-29 08:00:00+08:00" }],
    ["garbage timestamp", { observedAt: "not-a-date" }],
    ["empty qualificationRef", { qualificationRef: "" }],
    ["non-ascii qualificationRef", { qualificationRef: "observación" }],
  ])("refuses %s before any session", (_label, patch) => {
    const value = { ...serviceRaw, ...patch };
    expect(() => validateLeaseReductionServiceIdentity(value)).toThrow(
      LeaseReductionError,
    );
    try {
      validateLeaseReductionServiceIdentity(value);
    } catch (error) {
      expect((error as LeaseReductionError).code).toBe(
        "reduction_service_identity_invalid",
      );
    }
  });
  test("refuses a missing key", () => {
    const { observedAt: _drop, ...value } = serviceRaw;
    expect(() => validateLeaseReductionServiceIdentity(value)).toThrow(
      LeaseReductionError,
    );
  });
});

const remoteTools = {
  schema: LEASE_REDUCTION_TOOLS_SCHEMA_REMOTE,
  mode: "remote",
  totalBudgetMs: 60_000,
  cleanupBudgetMs: 5_000,
  validator: {
    id: "mirrors.model-interface-reduction/v1",
    path: "bin/model-interface-reduction",
    sha256: "b".repeat(64),
  },
};

describe("validateLeaseReductionRemoteTools", () => {
  test("accepts the remote manifest shape", () => {
    expect(validateLeaseReductionRemoteTools(remoteTools)).toMatchObject({
      mode: "remote",
      validator: { id: "mirrors.model-interface-reduction/v1" },
    });
  });
  test.each([
    ["v1 schema", { schema: "mirrorecma.lease-reduction-tools/v1" }],
    ["local mode field", { mode: "local" }],
    ["local Apalache pin present", { apalache: { version: "0.61.0" } }],
    ["zero total budget", { totalBudgetMs: 0 }],
    ["fractional cleanup budget", { cleanupBudgetMs: 1.5 }],
    ["wrong validator id", { validator: { ...remoteTools.validator, id: "other/v1" } }],
    ["bad validator digest", { validator: { ...remoteTools.validator, sha256: "xy" } }],
  ])("refuses %s", (_label, patch) => {
    expect(() =>
      validateLeaseReductionRemoteTools({ ...remoteTools, ...patch }),
    ).toThrow(LeaseReductionError);
  });
});

type Factories = {
  spawned: string[];
  connected: Array<{ host: string; port: number; opts: TlsOptions }>;
};
function fakeDeps(transport: TlsConnectTransport): {
  deps: Parameters<typeof openReductionOracleTransport>[1];
  factories: Factories;
} {
  const factories: Factories = { spawned: [], connected: [] };
  return {
    factories,
    deps: {
      spawnMirror: (binPath: string): Transport => {
        factories.spawned.push(binPath);
        return {} as Transport;
      },
      connectTlsMirror: async (
        host: string,
        port: number,
        opts: TlsOptions,
      ): Promise<TlsConnectTransport> => {
        factories.connected.push({ host, port, opts });
        return transport;
      },
    },
  };
}
function fakeTlsTransport(peerFingerprint: string): TlsConnectTransport & {
  closed: number;
} {
  return {
    peerFingerprint,
    closed: 0,
    send: () => {},
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
    close(): Promise<number> {
      this.closed += 1;
      return Promise.resolve(0);
    },
  } as unknown as TlsConnectTransport & { closed: number };
}

describe("openReductionOracleTransport", () => {
  test("local mode spawns the pinned mirror and never connects", async () => {
    const transport = fakeTlsTransport(FINGERPRINT);
    const { deps, factories } = fakeDeps(transport);
    const opened = await openReductionOracleTransport(
      { mode: "local", mirrorPath: "/opt/mirror/bin/mirror" },
      deps,
    );
    expect(factories.spawned).toEqual(["/opt/mirror/bin/mirror"]);
    expect(factories.connected).toEqual([]);
    expect(opened).toBeDefined();
  });
  test("remote mode connects with the identity pin and never spawns", async () => {
    const transport = fakeTlsTransport(FINGERPRINT);
    const { deps, factories } = fakeDeps(transport);
    const opened = await openReductionOracleTransport(
      {
        mode: "remote",
        service,
        tls: { caPath: "/r/ca.pem", certPath: "/r/cert.pem", keyPath: "/r/key.pem" },
      },
      deps,
    );
    expect(factories.spawned).toEqual([]);
    expect(factories.connected).toHaveLength(1);
    const call = factories.connected[0]!;
    expect(call.host).toBe("172.20.208.1");
    expect(call.port).toBe(8999);
    expect(call.opts.pin).toBe(FINGERPRINT);
    expect(call.opts.caPath).toBe("/r/ca.pem");
    expect(opened).toBe(transport);
  });
  test("peer fingerprint mismatch closes the transport before refusing", async () => {
    const transport = fakeTlsTransport("c".repeat(64));
    const { deps } = fakeDeps(transport);
    await expect(
      openReductionOracleTransport(
        {
          mode: "remote",
          service,
          tls: { caPath: "/r/ca.pem", certPath: "/r/cert.pem", keyPath: "/r/key.pem" },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "reduction_service_identity_mismatch" });
    expect(transport.closed).toBe(1);
  });
  test("unreachable service refuses without spawning locally", async () => {
    const deps = {
      spawnMirror: () => {
        throw new Error("spawn must not be called");
      },
      connectTlsMirror: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    await expect(
      openReductionOracleTransport(
        {
          mode: "remote",
          service,
          tls: { caPath: "/r/ca.pem", certPath: "/r/cert.pem", keyPath: "/r/key.pem" },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "reduction_service_unreachable" });
  });
  test("missing TLS credential path refuses before any factory call", async () => {
    const { deps, factories } = fakeDeps(fakeTlsTransport(FINGERPRINT));
    await expect(
      openReductionOracleTransport(
        {
          mode: "remote",
          service,
          tls: { caPath: "", certPath: "/r/cert.pem", keyPath: "/r/key.pem" },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "reduction_oracle_configuration_invalid" });
    expect(factories.spawned).toEqual([]);
    expect(factories.connected).toEqual([]);
  });
});

describe("applyOracleModeEnvironment", () => {
  test("remote mode removes any inherited APALACHE_MC and leaves PATH alone", () => {
    const env: Record<string, string | undefined> = {
      APALACHE_MC: "/pinned/local/apalache",
      PATH: "/usr/bin",
    };
    applyOracleModeEnvironment("remote", env);
    expect("APALACHE_MC" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
  });
  test("local mode pins the launcher and prepends the selected JDK", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    applyOracleModeEnvironment("local", env, {
      apalacheLauncherPath: "/tools/apalache/bin/apalache-mc",
      javaHome: "/tools/jdk",
    });
    expect(env.APALACHE_MC).toBe("/tools/apalache/bin/apalache-mc");
    expect(env.PATH).toBe("/tools/jdk/bin:/usr/bin");
  });
  test("local mode without tool paths is a configuration error", () => {
    expect(() => applyOracleModeEnvironment("local", {})).toThrow(
      LeaseReductionError,
    );
  });
});

describe("materialize-lease-reduction CLI (requires pnpm run build)", () => {
  const script = resolve("scripts/materialize-lease-reduction.mjs");
  function runCli(args: string[]): { status: number; stderr: string } {
    try {
      execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
      return { status: 0, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      return { status: failure.status ?? 1, stderr: failure.stderr ?? "" };
    }
  }
  const base = [
    "--candidate", "c.json", "--bundle", "b.json", "--model", "m.tla",
    "--lock", "l.json", "--original-trace", "t.json",
    "--tool-manifest", "tools.json", "--out", "o.json", "--receipt", "r.json",
  ];
  test("remote mode without TLS/service flags refuses at usage before file reads", () => {
    const result = runCli([...base, "--oracle-mode", "remote"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
  test("an unknown oracle mode refuses at usage before file reads", () => {
    const result = runCli([...base, "--oracle-mode", "sideways"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
});

describe("settleOracleCleanup", () => {
  test("a clean close is confirmed", async () => {
    let closed = 0;
    const settlement = await settleOracleCleanup(
      {
        close: async () => {
          closed += 1;
          return 0;
        },
      },
      50,
    );
    expect(settlement).toEqual({
      status: "confirmed",
      method: "forced_transport_close",
    });
    expect(closed).toBe(1);
  });

  test("a rejecting close is unconfirmed", async () => {
    const settlement = await settleOracleCleanup(
      {
        close: async () => {
          throw new Error("transport gone");
        },
      },
      50,
    );
    expect(settlement).toEqual({
      status: "unconfirmed",
      method: "forced_transport_close",
    });
  });

  test("a close hanging past the budget is unconfirmed", async () => {
    const settlement = await settleOracleCleanup(
      { close: () => new Promise<number>(() => {}) },
      10,
    );
    expect(settlement).toEqual({
      status: "unconfirmed",
      method: "forced_transport_close",
    });
  });
});
