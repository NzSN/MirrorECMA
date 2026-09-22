import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeReproductionBundle,
  reproductionBundleSha256,
  type ReproductionReplayResult,
} from "../src/reproduction-bundle.js";
import { reduceReproductionPrefix } from "../src/reproduction-prefix-reducer.js";
import type { ReproductionStabilityRecord } from "../src/reproduction-stability.js";
import {
  counterBundle,
  replayFaultyCounter,
} from "./support/reproduction-counter.js";

const bundle = decodeReproductionBundle(
  await readFile(
    resolve("test/fixtures/reproduction/accepted/behavioral-mismatch.json"),
    "utf8",
  ),
);
const stability: ReproductionStabilityRecord = {
  schema: "mirrorecma.reproduction-stability/v1",
  runId: bundle.evidenceLinks.runRef.runId,
  bundleSha256: reproductionBundleSha256(bundle),
  policy: {
    attemptLimit: 3,
    totalBudgetMs: 1000,
    perAttemptBudgetMs: 100,
    cleanupBudgetMs: 100,
  },
  resettable: true,
  classification: "stable",
  attempts: [],
  independence: "confirmed",
};
const policy = {
  candidateLimit: 20,
  totalBudgetMs: 1_000,
  perCandidateBudgetMs: 100,
  cleanupBudgetMs: 100,
};
function replay(
  status: "reproduced" | "not_reproduced",
  cleanup: "succeeded" | "failed" = "succeeded",
): ReproductionReplayResult {
  return {
    schema: "mirrorecma.reproduction-replay/v1",
    status,
    expected: bundle.signature,
    observed: status === "reproduced" ? bundle.signature : null,
    suiteResult: { cleanup: { status: cleanup } } as any,
  };
}

test("reports exact shortest reproducing prefix only after every shorter prefix is checked", async () => {
  const scopes: number[] = [];
  const result = await reduceReproductionPrefix(bundle, {
    traceIndex: 0,
    steps: [0, 1, 2, 3, 4, 5],
    stability,
    resettable: true,
    policy,
    validateCandidate: async () => ({ valid: true }),
    evaluateCandidate: async (prefix) => {
      scopes.push(prefix.length);
      return replay(prefix.length >= 3 ? "reproduced" : "not_reproduced");
    },
  });
  expect(result).toMatchObject({
    bestPrefixLength: 3,
    claim: "shortest_reproducing_prefix",
    minimalityComplete: true,
    stopReason: "complete",
  });
  expect(scopes).toEqual([6, 5, 4, 3, 2, 1]);
});

test("candidate limit reports only the smallest observed reproducing prefix", async () => {
  const result = await reduceReproductionPrefix(bundle, {
    traceIndex: 0,
    steps: [0, 1, 2, 3, 4, 5],
    stability,
    resettable: true,
    policy: { ...policy, candidateLimit: 2 },
    validateCandidate: async () => ({ valid: true }),
    evaluateCandidate: async () => replay("reproduced"),
  });
  expect(result).toMatchObject({
    bestPrefixLength: 5,
    claim: "smallest_observed_reproducing_prefix",
    minimalityComplete: false,
    stopReason: "candidate_limit",
  });
});

test("model-invalid and signature-drift candidates prevent a shortest-prefix claim", async () => {
  const result = await reduceReproductionPrefix(bundle, {
    traceIndex: 0,
    steps: [0, 1, 2, 3],
    stability,
    resettable: true,
    policy,
    validateCandidate: async (prefix) =>
      prefix.length === 2
        ? { valid: false, code: "model_invalid" }
        : { valid: true },
    evaluateCandidate: async (prefix) =>
      replay(prefix.length === 3 ? "reproduced" : "not_reproduced"),
  });
  expect(result).toMatchObject({
    bestPrefixLength: 3,
    claim: "smallest_observed_reproducing_prefix",
    minimalityComplete: false,
  });
  expect(result.candidates.find((c) => c.prefixLength === 2)).toMatchObject({
    validity: "invalid",
    outcome: "not_run",
  });
  expect(result.candidates.find((c) => c.prefixLength === 1)?.outcome).toBe(
    "not_reproduced",
  );
});

test("cleanup uncertainty hard-stops candidate evaluation", async () => {
  let calls = 0;
  const result = await reduceReproductionPrefix(bundle, {
    traceIndex: 0,
    steps: [0, 1, 2, 3],
    stability,
    resettable: true,
    policy,
    validateCandidate: async () => ({ valid: true }),
    evaluateCandidate: async () => {
      calls++;
      return replay("reproduced", calls === 2 ? "failed" : "succeeded");
    },
  });
  expect(result).toMatchObject({
    bestPrefixLength: 4,
    claim: "smallest_observed_reproducing_prefix",
    minimalityComplete: false,
    stopReason: "cleanup_independence_lost",
  });
  expect(calls).toBe(2);
});

test("unstable and non-resettable cases are ineligible", async () => {
  let calls = 0;
  const result = await reduceReproductionPrefix(bundle, {
    traceIndex: 0,
    steps: [0, 1],
    stability: { ...stability, classification: "unstable" },
    resettable: true,
    policy,
    validateCandidate: async () => {
      calls++;
      return { valid: true };
    },
    evaluateCandidate: async () => replay("reproduced"),
  });
  expect(result).toMatchObject({
    claim: "not_reduced",
    stopReason: "not_eligible",
  });
  expect(calls).toBe(0);
});

test("caller cancellation stops the bounded transcript", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await reduceReproductionPrefix(bundle, {
    traceIndex: 0,
    steps: [0, 1, 2],
    stability,
    resettable: true,
    policy,
    signal: controller.signal,
    validateCandidate: async () => ({ valid: true }),
    evaluateCandidate: async () => {
      calls++;
      controller.abort();
      return replay("reproduced");
    },
  });
  expect(result.stopReason).toBe("cancelled");
  expect(calls).toBe(1);
});

test("each prefix candidate uses a fresh real runSuite factory and disposer", async () => {
  const raw = await readFile(
    resolve("test/fixtures/reproduction/accepted/behavioral-mismatch.json"),
    "utf8",
  );
  const actualBundle = counterBundle(raw);
  const counts = { factories: 0, disposals: 0 };
  const actualStability: ReproductionStabilityRecord = {
    ...stability,
    runId: actualBundle.evidenceLinks.runRef.runId,
    bundleSha256: reproductionBundleSha256(actualBundle),
  };
  const result = await reduceReproductionPrefix(actualBundle, {
    traceIndex: 0,
    steps: [0, 1],
    stability: actualStability,
    resettable: true,
    policy: { ...policy, totalBudgetMs: 5_000, perCandidateBudgetMs: 1_000 },
    validateCandidate: async () => ({ valid: true }),
    evaluateCandidate: (_prefix, signal) =>
      replayFaultyCounter(actualBundle, counts, signal),
  });
  expect(result).toMatchObject({
    bestPrefixLength: 1,
    claim: "shortest_reproducing_prefix",
  });
  expect(counts).toEqual({ factories: 2, disposals: 2 });
});

test("a stale callback reproduction claim is rejected as a candidate failure", async () => {
  const stale = replay("reproduced") as any;
  stale.observed = {
    ...bundle.signature,
    primary: { ...bundle.signature.primary, stateIndex: 99 },
  };
  const result = await reduceReproductionPrefix(bundle, {
    traceIndex: 0,
    steps: [0],
    stability,
    resettable: true,
    policy,
    validateCandidate: async () => ({ valid: true }),
    evaluateCandidate: async () => stale,
  });
  expect(result).toMatchObject({
    bestPrefixLength: null,
    stopReason: "candidate_failure",
    candidates: [{ code: "stale_replay_result" }],
  });
});
