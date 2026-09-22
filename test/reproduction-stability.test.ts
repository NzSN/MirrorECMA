import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeReproductionBundle,
  type ReproductionReplayResult,
} from "../src/reproduction-bundle.js";
import { classifyReproductionStability } from "../src/reproduction-stability.js";
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
function replay(
  status: "reproduced" | "not_reproduced",
  cleanup: "succeeded" | "failed" | "unconfirmed" = "succeeded",
): ReproductionReplayResult {
  return {
    schema: "mirrorecma.reproduction-replay/v1",
    status,
    expected: bundle.signature,
    observed: status === "reproduced" ? bundle.signature : null,
    suiteResult: { cleanup: { status: cleanup } } as any,
  };
}
const policy = {
  attemptLimit: 4,
  totalBudgetMs: 1_000,
  perAttemptBudgetMs: 100,
  cleanupBudgetMs: 100,
};

test("stable, not reproduced, and alternating outcomes are distinct", async () => {
  const stable = await classifyReproductionStability(bundle, {
    policy,
    resettable: true,
    attempt: async () => replay("reproduced"),
  });
  expect(stable).toMatchObject({
    classification: "stable",
    independence: "confirmed",
  });
  expect(stable.attempts).toHaveLength(4);
  const absent = await classifyReproductionStability(bundle, {
    policy,
    resettable: true,
    attempt: async () => replay("not_reproduced"),
  });
  expect(absent.classification).toBe("not_reproduced");
  const alternating = await classifyReproductionStability(bundle, {
    policy,
    resettable: true,
    attempt: async (n) => replay(n % 2 ? "reproduced" : "not_reproduced"),
  });
  expect(alternating.classification).toBe("unstable");
  expect(alternating.attempts.map((a) => a.attempt)).toEqual([1, 2, 3, 4]);
});

test("one-off failure is inconclusive and stops further attempts", async () => {
  let calls = 0;
  const result = await classifyReproductionStability(bundle, {
    policy,
    resettable: true,
    attempt: async () => {
      calls++;
      if (calls === 2)
        throw Object.assign(new Error("infra"), { code: "transport_failed" });
      return replay("reproduced");
    },
  });
  expect(result.classification).toBe("inconclusive");
  expect(calls).toBe(2);
  expect(result.attempts.at(-1)?.outcome).toBe("failed");
});

test("per-attempt timeout is bounded and cannot satisfy a mismatch", async () => {
  const result = await classifyReproductionStability(bundle, {
    policy: { ...policy, perAttemptBudgetMs: 10 },
    resettable: true,
    attempt: async () => new Promise(() => {}),
  });
  expect(result).toMatchObject({
    classification: "inconclusive",
    independence: "lost",
    reasonCode: "timed_out",
  });
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]?.outcome).toBe("timed_out");
});

test("caller cancellation returns cancelled with exact attempted order", async () => {
  const controller = new AbortController();
  const result = await classifyReproductionStability(bundle, {
    policy,
    resettable: true,
    signal: controller.signal,
    attempt: async (n) => {
      if (n === 2) controller.abort("stop");
      return n === 1 ? replay("reproduced") : new Promise(() => {});
    },
  });
  expect(result.classification).toBe("cancelled");
  expect(result.attempts.map((a) => a.attempt)).toEqual([1, 2]);
});

test("cleanup loss stops before the next fresh trial", async () => {
  let calls = 0;
  const result = await classifyReproductionStability(bundle, {
    policy,
    resettable: true,
    attempt: async () => {
      calls++;
      return replay("reproduced", calls === 2 ? "failed" : "succeeded");
    },
  });
  expect(result).toMatchObject({
    classification: "inconclusive",
    independence: "lost",
    reasonCode: "cleanup_independence_lost",
  });
  expect(calls).toBe(2);
  expect(result.attempts[1]?.outcome).toBe("cleanup_unconfirmed");
});

test("non-resettable bundles preserve the original reference without attempts", async () => {
  let calls = 0;
  const result = await classifyReproductionStability(bundle, {
    policy,
    resettable: false,
    attempt: async () => {
      calls++;
      return replay("reproduced");
    },
  });
  expect(result).toMatchObject({
    classification: "inconclusive",
    independence: "not_established",
    reasonCode: "not_resettable",
    runId: bundle.evidenceLinks.runRef.runId,
  });
  expect(calls).toBe(0);
});

test("each stability attempt uses a fresh real runSuite factory and disposer", async () => {
  const raw = await readFile(
    resolve("test/fixtures/reproduction/accepted/behavioral-mismatch.json"),
    "utf8",
  );
  const actualBundle = counterBundle(raw);
  const counts = { factories: 0, disposals: 0 };
  const result = await classifyReproductionStability(actualBundle, {
    policy: { ...policy, attemptLimit: 3 },
    resettable: true,
    attempt: (_attempt, signal) =>
      replayFaultyCounter(actualBundle, counts, signal),
  });
  expect(result.classification).toBe("stable");
  expect(counts).toEqual({ factories: 3, disposals: 3 });
});

test("a callback cannot claim reproduced with a stale expected or observed signature", async () => {
  const stale = replay("reproduced") as any;
  stale.expected = {
    ...bundle.signature,
    primary: { ...bundle.signature.primary, action: "different" },
  };
  const result = await classifyReproductionStability(bundle, {
    policy,
    resettable: true,
    attempt: async () => stale,
  });
  expect(result).toMatchObject({
    classification: "inconclusive",
    reasonCode: "stale_replay_result",
  });
  expect(result.attempts).toHaveLength(1);
});
