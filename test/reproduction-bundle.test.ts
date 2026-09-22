import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import {
  ReproductionBundleError,
  ReproductionRefusalError,
  captureReproduction,
  decodeReproductionBundle,
  preflightReproduction,
  projectReproductionPublicSummary,
  replayReproduction,
  validateReproductionBundle,
  type ReproductionBundle,
  type ReproductionPreflightOptions,
} from "../src/reproduction-bundle.js";
import type { SuiteResult } from "../src/suite-result.js";

const fixtureRoot = resolve("test/fixtures/reproduction");
async function fixture(
  kind: "accepted" | "rejected",
  name: string,
): Promise<string> {
  return readFile(join(fixtureRoot, kind, name), "utf8");
}
async function accepted(
  name = "behavioral-mismatch.json",
): Promise<ReproductionBundle> {
  return decodeReproductionBundle(await fixture("accepted", name));
}
function suiteResult(kind: "mismatch" | "passed" = "mismatch"): SuiteResult {
  const result: SuiteResult = {
    schema: "mirrorecma.suite-result/v1",
    suiteId: "fixture-suite/v1",
    outcome: kind === "mismatch" ? "mismatch" : "passed",
    conformance: kind === "mismatch" ? "mismatch" : "matched",
    acceptance: { status: "met", missingActions: [], missingPairs: [] },
    cleanup: {
      scope: "local",
      status: "succeeded",
      quiescence: "confirmed",
      bindingStatus: "succeeded",
    },
    identities: {
      interfaceDigest: "6".repeat(64),
      modelDigest: "4".repeat(64),
      corpusDigest: "5".repeat(64),
    },
    evidence: {
      schema: "mirrorecma.suite-evidence/v1",
      enteredReplay: true,
      complete: kind === "passed",
      exact: true,
      tracesExpected: 1,
      tracesCompleted: kind === "passed" ? 1 : 0,
      initializationsMatched: "1",
      transitionsMatched: kind === "passed" ? "2" : "1",
      actionCounts: {},
      pairCounts: {},
    },
    ...(kind === "mismatch"
      ? {
          failure: {
            stage: "replay",
            kind: "mismatch",
            code: "model_mismatch",
            message: "model rejected observation",
            traceIndex: 0,
            stateIndex: 2,
          },
        }
      : {}),
  };
  if (kind === "mismatch")
    Object.defineProperty(result, "trustedError", {
      value: Object.freeze({ action: "enqueue" }),
      enumerable: false,
    });
  return Object.freeze(result);
}
function preflightOptions(
  bundle: ReproductionBundle,
  effects: { evidence: number; resolver: number },
): ReproductionPreflightOptions {
  return {
    expectedIdentities: bundle.identities,
    expectedCatalogSelection: bundle.evidenceLinks.catalogSelectionRef,
    validateEvidenceLinks: (links) => {
      effects.evidence++;
      expect(links.runRef.projectionKind).toBe("private");
    },
    admittedResolvers: new Set(["fixture-private-store/v1"]),
    resolveExternal: (reference) => {
      effects.resolver++;
      expect(reference.resolver).toBe("fixture-private-store/v1");
      return "EXTERNAL_PRIVATE_CANARY";
    },
  };
}

test("production decoder accepts every family without resolving external data", async () => {
  const names = (await readdir(join(fixtureRoot, "accepted"))).sort();
  expect(names).toEqual([
    "behavioral-mismatch.json",
    "cancellation.json",
    "cleanup-failure.json",
    "codec-error.json",
    "coverage-unmet.json",
    "implementation-error.json",
    "observer-error.json",
    "timeout.json",
  ]);
  let resolverCalls = 0;
  for (const name of names) {
    const bundle = decodeReproductionBundle(await fixture("accepted", name));
    expect(bundle.captures).toHaveLength(2);
    expect(resolverCalls).toBe(0);
    expect(
      JSON.stringify(projectReproductionPublicSummary(bundle)),
    ).not.toContain("PRIVATE_CANARY");
  }
});

test("production decoder rejects the complete rejected corpus", async () => {
  const names = await readdir(join(fixtureRoot, "rejected"));
  expect(names).toHaveLength(11);
  for (const name of names) {
    const raw = await fixture("rejected", name);
    expect(() => decodeReproductionBundle(raw)).toThrow(
      ReproductionBundleError,
    );
  }
});

test("bounded decoder rejects duplicate keys before JSON.parse can erase them", async () => {
  const raw = await fixture("accepted", "behavioral-mismatch.json");
  expect(() =>
    decodeReproductionBundle(`{"schema":"duplicate",${raw.slice(1)}`),
  ).toThrow(expect.objectContaining({ code: "bundle_duplicate_key" }));
});

test("in-memory validation rejects accessors without invoking them", async () => {
  const value = JSON.parse(
    await fixture("accepted", "behavioral-mismatch.json"),
  ) as Record<string, unknown>;
  let invoked = false;
  Object.defineProperty(value, "schema", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("getter ran");
    },
  });
  expect(() => validateReproductionBundle(value)).toThrow(
    expect.objectContaining({ code: "bundle_non_data_property" }),
  );
  expect(invoked).toBe(false);
});

test.each([
  [
    "false dirty component with dirtyContent",
    (value: any) => {
      value.evidenceLinks.componentRefs[0].dirtyContent = {
        digest: "a".repeat(64),
      };
    },
  ],
  [
    "mismatched run projection",
    (value: any) => {
      value.evidenceLinks.runRef.projectionKind = "public";
    },
  ],
  [
    "nested malformed artifact location",
    (value: any) => {
      value.evidenceLinks.artifactRefs[0].location.path = "../private";
    },
  ],
])("rejects malformed E1 reference: %s", async (_name, mutate) => {
  const value = JSON.parse(
    await fixture("accepted", "behavioral-mismatch.json"),
  );
  mutate(value);
  expect(() => validateReproductionBundle(value)).toThrow();
});

test("duplicate component and artifact IDs are rejected even when their records differ", async () => {
  for (const kind of ["component", "artifact"] as const) {
    const value: any = JSON.parse(
      await fixture("accepted", "behavioral-mismatch.json"),
    );
    if (kind === "component")
      value.evidenceLinks.componentRefs.push({
        ...value.evidenceLinks.componentRefs[0],
        revision: "c".repeat(40),
      });
    else
      value.evidenceLinks.artifactRefs.push({
        ...value.evidenceLinks.artifactRefs[0],
        sha256: "c".repeat(64),
      });
    expect(() => validateReproductionBundle(value)).toThrow(
      expect.objectContaining({ code: "evidence_ref_invalid" }),
    );
  }
});

test("Uint8Array decoding rejects malformed UTF-8", () => {
  expect(() =>
    decodeReproductionBundle(
      Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
    ),
  ).toThrow(expect.objectContaining({ code: "bundle_utf8_invalid" }));
});

test("explicit preflight resolves admitted artifacts before evaluator acquisition", async () => {
  const bundle = await accepted();
  const effects = { evidence: 0, resolver: 0, evaluator: 0 };
  const observed = suiteResult();
  const result = await replayReproduction(bundle, {
    ...preflightOptions(bundle, effects),
    evaluate: async () => {
      effects.evaluator++;
      return observed;
    },
  });
  expect(result.status).toBe("reproduced");
  expect(effects).toEqual({ evidence: 1, resolver: 1, evaluator: 1 });
  expect(result.suiteResult).toBe(observed);
  expect(Object.keys(result)).not.toContain("suiteResult");
});

test("identity, catalog, and external digest refusals happen before evaluator acquisition", async () => {
  const bundle = await accepted();
  for (const change of ["identity", "catalog", "external"] as const) {
    const effects = { evidence: 0, resolver: 0, evaluator: 0 };
    const options: any = {
      ...preflightOptions(bundle, effects),
      evaluate: async () => {
        effects.evaluator++;
        return suiteResult();
      },
    };
    if (change === "identity")
      options.expectedIdentities = {
        ...bundle.identities,
        suite: { ...bundle.identities.suite, id: "other/v1" },
      };
    if (change === "catalog")
      options.expectedCatalogSelection = {
        ...bundle.evidenceLinks.catalogSelectionRef,
        selectionValue: "f".repeat(64),
      };
    if (change === "external")
      options.resolveExternal = () => {
        effects.resolver++;
        return "wrong";
      };
    await expect(replayReproduction(bundle, options)).rejects.toBeInstanceOf(
      ReproductionRefusalError,
    );
    expect(effects.evaluator).toBe(0);
    if (change !== "external") expect(effects.resolver).toBe(0);
  }
});

test("correct behavior does not reproduce a mismatch signature", async () => {
  const bundle = await accepted(),
    effects = { evidence: 0, resolver: 0 };
  const result = await replayReproduction(bundle, {
    ...preflightOptions(bundle, effects),
    evaluate: async () => suiteResult("passed"),
  });
  expect(result.status).toBe("not_reproduced");
  expect(result.observed).toBeNull();
});

test("persistence denial preserves the behavioral result and fails evidence handling", async () => {
  const bundle = await accepted();
  const capture = await captureReproduction(suiteResult(), {
    evidenceLinks: bundle.evidenceLinks,
    identities: bundle.identities,
    captures: bundle.captures,
    handling: bundle.handling,
    persist: () => {
      throw new Error("denied");
    },
  });
  expect(capture.bundle.signature).toEqual(bundle.signature);
  expect(capture.persistence).toEqual({
    status: "failed",
    code: "reproduction_persistence_failed",
  });
  expect(capture.suiteResult).toBeDefined();
  expect(Object.keys(capture)).not.toContain("suiteResult");
});

test("explicit preflight alone performs no factory or Gate acquisition", async () => {
  const bundle = await accepted(),
    effects = { evidence: 0, resolver: 0, factory: 0, gate: 0 };
  await preflightReproduction(bundle, preflightOptions(bundle, effects));
  expect(effects).toEqual({ evidence: 1, resolver: 1, factory: 0, gate: 0 });
});

test("external resolution is byte-, deadline-, and cancellation-bounded", async () => {
  const bundle = await accepted();
  for (const kind of ["bytes", "deadline", "cancel"] as const) {
    const effects = { evidence: 0, resolver: 0 },
      controller = new AbortController();
    const options: any = {
      ...preflightOptions(bundle, effects),
      signal: controller.signal,
      externalLimits: {
        perReferenceBytes: 4,
        aggregateBytes: 4,
        resolutionMs: 10,
      },
    };
    if (kind === "bytes")
      options.resolveExternal = () => "EXTERNAL_PRIVATE_CANARY";
    else
      options.resolveExternal = (_ref: any, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
    if (kind === "cancel") controller.abort("cancel");
    await expect(preflightReproduction(bundle, options)).rejects.toBeInstanceOf(
      ReproductionRefusalError,
    );
  }
});

test("public projection accepts only decimal counts and unique SHA-256 hashes", async () => {
  const bundle = await accepted();
  expect(
    projectReproductionPublicSummary(bundle, {
      counts: { killed: "17" },
      implementationHashes: ["a".repeat(64)],
    }),
  ).toMatchObject({ approvedCounts: { killed: "17" } });
  expect(() =>
    projectReproductionPublicSummary(bundle, { counts: { killed: "1.5" } }),
  ).toThrow(expect.objectContaining({ code: "public_projection_invalid" }));
  expect(() =>
    projectReproductionPublicSummary(bundle, {
      implementationHashes: ["a".repeat(64), "a".repeat(64)],
    }),
  ).toThrow(expect.objectContaining({ code: "public_projection_invalid" }));
});

test("never-settling evidence and compatibility validators are deadline bounded before evaluation", async () => {
  const bundle = await accepted();
  for (const callback of ["evidence", "compatibility"] as const) {
    const effects = { evidence: 0, resolver: 0, evaluator: 0 };
    const options: any = {
      ...preflightOptions(bundle, effects),
      validationMs: 10,
      evaluate: async () => {
        effects.evaluator++;
        return suiteResult();
      },
    };
    if (callback === "evidence")
      options.validateEvidenceLinks = () => new Promise(() => {});
    else options.validateCompatibility = () => new Promise(() => {});
    await expect(replayReproduction(bundle, options)).rejects.toMatchObject({
      code: "preflight_validation_timeout",
    });
    expect(effects.evaluator).toBe(0);
    if (callback === "evidence") expect(effects.resolver).toBe(0);
  }
});

test("inline base64 accepts the exact 262144-byte boundary without widening ordinary strings", async () => {
  const value: any = JSON.parse(
    await fixture("accepted", "behavioral-mismatch.json"),
  );
  const bytes = Buffer.alloc(262_144);
  value.captures[0].bytes = bytes.length;
  value.captures[0].base64 = bytes.toString("base64");
  value.captures[0].sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(
    decodeReproductionBundle(JSON.stringify(value)).captures[0],
  ).toMatchObject({
    bytes: 262_144,
  });
  const tooLarge = Buffer.alloc(262_145);
  value.captures[0].bytes = tooLarge.length;
  value.captures[0].base64 = tooLarge.toString("base64");
  value.captures[0].sha256 = createHash("sha256")
    .update(tooLarge)
    .digest("hex");
  expect(() => decodeReproductionBundle(JSON.stringify(value))).toThrow();
  value.captures[0] = {
    role: "inline-private-canary",
    kind: "inline",
    mediaType: "text/plain",
    bytes: 0,
    sha256: createHash("sha256").update("").digest("hex"),
    base64: "",
  };
  value.handling.accessPolicyId = `a${"b".repeat(65_536)}`;
  expect(() => decodeReproductionBundle(JSON.stringify(value))).toThrow(
    expect.objectContaining({ code: "bundle_string_too_large" }),
  );
});
