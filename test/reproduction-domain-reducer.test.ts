import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LEASE_REDUCTION_DOMAIN_VERSION,
  LEASE_REDUCTION_PROFILE,
  LEASE_REDUCTION_SCHEMA,
  LeaseReductionError,
  decodeReproductionBundle,
  preflightSuite,
  reduceLeaseServiceInput,
  reproductionBundleSha256,
  runSuite,
  signatureFromSuiteResult,
  signaturesEqual,
  materializeLeaseReductionTrace,
  validateReproductionBundle,
  type LeaseOracleReceipt,
  type LeaseReductionAuthority,
  type LeaseReductionCandidate,
  type ReproductionReplayResult,
  type ReproductionStabilityRecord,
} from "../src/index.js";
import {
  defineApplicationSuite,
  model,
} from "../examples/lease-service/suite.js";
import { createAdapter } from "../examples/lease-service/service.mjs";

const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const modelPath = resolve("examples/lease-service/specs/LeaseService.tla");
const originalTrace = resolve(
  "examples/lease-service/artifacts/witness.itf.json",
);
const mirror = resolve("../Mirrors/.lake/build/bin/mirror");
let directory: string;
let candidateTrace: string;
let candidateTraceSha256: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lease-reduction-"));
  const trace = JSON.parse(await readFile(originalTrace, "utf8"));
  trace.states[2].parameters.client["#bigint"] = "1";
  candidateTrace = join(directory, "candidate.itf.json");
  const encoded = JSON.stringify(trace);
  await writeFile(candidateTrace, encoded);
  candidateTraceSha256 = sha(encoded);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const originalSha = sha(await readFile(originalTrace));
  const originalSuite = defineApplicationSuite(modelPath, [
    { path: originalTrace, sha256: originalSha },
    { path: originalTrace, sha256: originalSha },
  ]);
  const originalPreflight = await preflightSuite(originalSuite);
  const fixture = JSON.parse(
    await readFile(
      resolve("test/fixtures/reproduction/accepted/behavioral-mismatch.json"),
      "utf8",
    ),
  );
  fixture.signature.primary = {
    kind: "behavioral_mismatch",
    code: "replay_mismatch",
    traceIndex: 0,
    stateIndex: 2,
    action: "acquire",
  };
  fixture.identities.suite.id = originalSuite.id;
  fixture.identities.model.sourceClosureSha256 = originalPreflight.modelDigest;
  fixture.identities.corpus = {
    orderedOccurrencesSha256: originalPreflight.corpusDigest,
    traceCount: 2,
  };
  fixture.identities.generatedInterface.semanticDigest = model.semanticDigest;
  const bundle = validateReproductionBundle(fixture);
  const candidate: LeaseReductionCandidate = {
    schema: LEASE_REDUCTION_SCHEMA,
    modelSha256: originalPreflight.modelDigest,
    interfaceDigest: model.semanticDigest,
    orderedCorpusSha256: originalPreflight.corpusDigest,
    originalBundleSha256: reproductionBundleSha256(bundle),
    selectedTraceSha256: originalSha,
    traceIndex: 0,
    traceOccurrences: [0, 1],
    edits: [
      {
        stateIndex: 2,
        actionId: "Acquire",
        inputId: "Client",
        before: 2,
        after: 1,
      },
    ],
  };
  const authority: LeaseReductionAuthority = {
    profile: LEASE_REDUCTION_PROFILE,
    domainVersion: LEASE_REDUCTION_DOMAIN_VERSION,
    validator: {
      id: "mirrors.model-interface-reduction/v1",
      sha256: "e".repeat(64),
    },
    apalache: { version: "0.61.0", sha256: "f".repeat(64) },
    java: {
      observedVersion: "25.0.4+7-LTS",
      selectedVersion: "25.0.4+7",
      executableSha256: "1".repeat(64),
      archiveSha256: "2".repeat(64),
      distributionQualified: true,
      qualificationRef: `microsoft-jdk-25.0.4+7-linux-x64/sha256:${"2".repeat(64)}`,
    },
  };
  const stability: ReproductionStabilityRecord = {
    schema: "mirrorecma.reproduction-stability/v1",
    runId: bundle.evidenceLinks.runRef.runId,
    bundleSha256: reproductionBundleSha256(bundle),
    policy: {
      attemptLimit: 3,
      totalBudgetMs: 1_000,
      perAttemptBudgetMs: 100,
      cleanupBudgetMs: 100,
    },
    resettable: true,
    classification: "stable",
    attempts: [],
    independence: "confirmed",
  };
  const candidateSuite = defineApplicationSuite(modelPath, [
    { path: candidateTrace, sha256: candidateTraceSha256 },
    { path: candidateTrace, sha256: candidateTraceSha256 },
  ]);
  const candidatePreflight = await preflightSuite(candidateSuite);
  const receipt: LeaseOracleReceipt = {
    schema: "mirrorecma.lease-reduction-oracle/v1",
    status: "model_valid",
    profile: authority.profile,
    domainVersion: authority.domainVersion,
    modelSha256: candidate.modelSha256,
    interfaceDigest: candidate.interfaceDigest,
    originalCorpusSha256: candidate.orderedCorpusSha256,
    candidateCorpusSha256: candidatePreflight.corpusDigest,
    selectedTraceSha256: candidate.selectedTraceSha256,
    traceOccurrences: candidate.traceOccurrences,
    validator: authority.validator,
    apalache: authority.apalache,
    java: authority.java,
  };
  return {
    bundle,
    candidate,
    authority,
    stability,
    candidateSuite,
    receipt,
  };
}
function options(
  setupValue: Awaited<ReturnType<typeof setup>>,
  counts: { materialize: number; factories: number; disposals: number },
) {
  return {
    applicationId: "lease-service",
    candidate: setupValue.candidate,
    authority: setupValue.authority,
    stability: setupValue.stability,
    resettable: true,
    policy: {
      totalBudgetMs: 5_000,
      oracleBudgetMs: 500,
      evaluationBudgetMs: 2_000,
      cleanupBudgetMs: 500,
    },
    materialize: async () => {
      counts.materialize++;
      return { suite: setupValue.candidateSuite, receipt: setupValue.receipt };
    },
    evaluate: async (
      suite: typeof setupValue.candidateSuite,
      signal: AbortSignal,
    ) => {
      const result = await runSuite(suite, {
        mirror,
        signal,
        implementation: async (context) => {
          counts.factories++;
          const adapter = createAdapter("overlapping-ownership");
          const dispose = context.deferCleanup(async () => {
            await adapter.dispose();
            counts.disposals++;
          });
          return { port: adapter, dispose };
        },
      });
      const observed = signatureFromSuiteResult(result);
      const replay: ReproductionReplayResult = {
        schema: "mirrorecma.reproduction-replay/v1",
        status:
          observed !== null &&
          signaturesEqual(setupValue.bundle.signature, observed)
            ? "reproduced"
            : "not_reproduced",
        expected: setupValue.bundle.signature,
        observed,
      };
      Object.defineProperty(replay, "suiteResult", {
        value: result,
        enumerable: false,
      });
      return replay;
    },
  };
}

test("LeaseService Client 2 to 1 remains model-preflighted and reproduces the exact mismatch", async () => {
  const value = await setup();
  const counts = { materialize: 0, factories: 0, disposals: 0 };
  const result = await reduceLeaseServiceInput(
    value.bundle,
    options(value, counts),
  );
  expect(result).toMatchObject({
    status: "reduced",
    globalMinimumClaim: false,
    oracle: { status: "model_valid" },
  });
  expect(counts).toEqual({ materialize: 1, factories: 1, disposals: 1 });
});

test("unsupported application and invalid transform never invoke the oracle or SUT", async () => {
  const value = await setup();
  for (const kind of ["application", "transform"] as const) {
    const counts = { materialize: 0, factories: 0, disposals: 0 };
    const actual = options(value, counts) as any;
    if (kind === "application") actual.applicationId = "work-queue";
    else
      actual.candidate = {
        ...value.candidate,
        edits: [{ ...value.candidate.edits[0], after: 2 }],
      };
    if (kind === "application")
      expect(await reduceLeaseServiceInput(value.bundle, actual)).toMatchObject(
        {
          status: "reduction_profile_unsupported",
        },
      );
    else
      await expect(
        reduceLeaseServiceInput(value.bundle, actual),
      ).rejects.toBeInstanceOf(LeaseReductionError);
    expect(counts).toEqual({ materialize: 0, factories: 0, disposals: 0 });
  }
});

test("materialized input mismatch is rejected before application construction", async () => {
  const value = await setup();
  const trace = JSON.parse(await readFile(candidateTrace, "utf8"));
  trace.states[2].parameters.client["#bigint"] = "2";
  await writeFile(candidateTrace, JSON.stringify(trace));
  const changedSha = sha(await readFile(candidateTrace));
  const badSuite = defineApplicationSuite(modelPath, [
    { path: candidateTrace, sha256: changedSha },
    { path: candidateTrace, sha256: changedSha },
  ]);
  const counts = { materialize: 0, factories: 0, disposals: 0 };
  const actual = options(value, counts);
  actual.materialize = async () => {
    counts.materialize++;
    return { suite: badSuite, receipt: value.receipt };
  };
  await expect(reduceLeaseServiceInput(value.bundle, actual)).resolves.toMatchObject({
    status: "inconclusive",
    reasonCode: "model_oracle_error",
  });
  expect(counts.factories).toBe(0);
});

test("oracle errors become structured failures before application construction", async () => {
  const value = await setup();
  const counts = { materialize: 0, factories: 0, disposals: 0 };
  const actual = options(value, counts);
  actual.materialize = async () => {
    counts.materialize++;
    throw new Error("oracle failed");
  };
  await expect(reduceLeaseServiceInput(value.bundle, actual)).resolves.toMatchObject({
    status: "inconclusive",
    reasonCode: "model_oracle_error",
  });
  expect(counts).toEqual({ materialize: 1, factories: 0, disposals: 0 });
});

test("oracle timeout and caller cancellation are bounded before SUT construction", async () => {
  const value = await setup();
  for (const kind of ["timeout", "cancel"] as const) {
    const counts = { materialize: 0, factories: 0, disposals: 0 };
    const controller = new AbortController();
    const actual = options(value, counts);
    actual.policy = { ...actual.policy, oracleBudgetMs: 10 };
    actual.materialize = async (_candidate, signal) => {
      counts.materialize++;
      if (kind === "cancel") controller.abort("stop");
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    };
    const result = await reduceLeaseServiceInput(value.bundle, {
      ...actual,
      signal: controller.signal,
    });
    expect(result.status).toBe(
      kind === "cancel" ? "cancelled" : "inconclusive",
    );
    expect(counts.factories).toBe(0);
  }
});

test("valid candidate with different signature is not accepted as a reduction", async () => {
  const value = await setup();
  const counts = { materialize: 0, factories: 0, disposals: 0 };
  const actual = options(value, counts);
  actual.evaluate = async () => ({
    schema: "mirrorecma.reproduction-replay/v1",
    status: "not_reproduced",
    expected: value.bundle.signature,
    observed: null,
    suiteResult: { cleanup: { status: "succeeded" } } as any,
  });
  expect(await reduceLeaseServiceInput(value.bundle, actual)).toMatchObject({
    status: "not_reproduced",
  });
});

test("materialization rejects a changed action, wrong before value, and undeclared edits", async () => {
  const value = await setup();
  const original = JSON.parse(await readFile(originalTrace, "utf8"));
  const changedAction = structuredClone(original);
  changedAction.states[2].action_taken = "write";
  expect(() =>
    materializeLeaseReductionTrace(changedAction, value.candidate),
  ).toThrow(/action/);

  const wrongBefore = {
    ...value.candidate,
    edits: [{ ...value.candidate.edits[0], before: 1 }],
  } as any;
  expect(() => materializeLeaseReductionTrace(original, wrongBefore)).toThrow();

  const materialized = materializeLeaseReductionTrace(
    original,
    value.candidate,
  );
  expect(materialized.changedPaths).toEqual([
    "/states/2/parameters/client/#bigint",
  ]);
  const injected = structuredClone(materialized.trace) as any;
  injected.states[2].accepted = true;
  expect(injected).not.toEqual(materialized.trace);
  expect(materialized.changedPaths).not.toContain("/states/2/accepted");
});
