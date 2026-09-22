import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertMutationProtectedInputs,
  decodeMutationCampaign,
  runMutationCampaign,
  type MutationCampaignPolicy,
  type MutationEvaluation,
} from "../src/mutation-campaign.js";
import type { SuiteFailure, SuiteResult } from "../src/suite-result.js";

const knownActions = new Set([
  "acquire",
  "advance",
  "begin",
  "cancel",
  "chunk",
  "commit",
  "complete",
  "enqueue",
  "fail",
  "init",
  "pause",
  "release",
  "renew",
  "reset",
  "restart",
  "resume",
  "retry",
  "start",
  "write",
]);
const campaign = decodeMutationCampaign(
  await readFile(
    resolve(
      "test/fixtures/mutation-campaign/accepted/current-17-local-17-gate.json",
    ),
    "utf8",
  ),
  { knownActions },
);
const policy: MutationCampaignPolicy = {
  maxMutants: 256,
  totalBudgetMs: 10_000,
  perRunBudgetMs: 500,
  cleanupBudgetMs: 100,
};
function result(
  outcome: SuiteResult["outcome"],
  failure?: SuiteFailure,
  cleanup: "succeeded" | "failed" | "unconfirmed" = "succeeded",
): SuiteResult {
  return {
    schema: "mirrorecma.suite-result/v1",
    suiteId: "campaign",
    outcome,
    conformance:
      outcome === "passed"
        ? "matched"
        : failure?.kind === "mismatch"
          ? "mismatch"
          : "incomplete",
    acceptance: {
      status: outcome === "passed" ? "met" : "incomplete",
      missingActions: [],
      missingPairs: [],
    },
    cleanup: {
      scope: "local",
      status: cleanup,
      quiescence: cleanup === "succeeded" ? "confirmed" : "unconfirmed",
      bindingStatus: cleanup,
    },
    identities: { interfaceDigest: "a".repeat(64) },
    evidence: {
      schema: "mirrorecma.suite-evidence/v1",
      enteredReplay: true,
      complete: outcome === "passed",
      exact: true,
      tracesExpected: 1,
      tracesCompleted: outcome === "passed" ? 1 : 0,
      initializationsMatched: "1",
      transitionsMatched: "0",
      actionCounts: {},
      pairCounts: {},
    },
    ...(failure ? { failure } : {}),
  };
}
function pass(
  probe: MutationEvaluation["probe"] = { status: "passed" },
): MutationEvaluation {
  return { suiteResult: result("passed"), probe };
}
function mismatch(
  expected: { traceIndex: number; stateIndex: number; action: string },
  cleanup: "succeeded" | "failed" = "succeeded",
  probe: MutationEvaluation["probe"] = { status: "passed" },
): MutationEvaluation {
  const suite = result(
    "mismatch",
    {
      stage: "replay",
      kind: "mismatch",
      code: "model_mismatch",
      message: "mismatch",
      traceIndex: expected.traceIndex,
      stateIndex: expected.stateIndex,
    },
    cleanup,
  );
  Object.defineProperty(suite, "trustedError", {
    value: { action: expected.action },
    enumerable: false,
  });
  return { suiteResult: suite, probe };
}
function failed(
  kind: SuiteFailure["kind"],
  stage: SuiteFailure["stage"] = "replay",
  code = `${kind}_failure`,
): MutationEvaluation {
  return {
    suiteResult: result("failed", { stage, kind, code, message: "failed" }),
    probe: { status: "not_run" },
  };
}
function gate(evaluation: MutationEvaluation): MutationEvaluation {
  return {
    ...evaluation,
    cleanup: [
      {
        scope: "local-cooperative",
        requirement: "required",
        status: "confirmed",
      },
      {
        scope: "gate-physical",
        requirement: "required",
        status: "confirmed",
      },
    ],
  };
}

test("local campaign runs correct baseline first and kills all 17 exact mutants sequentially", async () => {
  const order: string[] = [];
  const report = await runMutationCampaign(campaign, {
    path: "local",
    observedProtected: campaign.protected,
    policy,
    evaluate: async (scenario) => {
      order.push(scenario.id);
      return scenario.kind === "correct"
        ? pass()
        : mismatch(scenario.mutant!.expected);
    },
  });
  expect(report).toMatchObject({
    status: "complete",
    acceptance: { status: "met", reasonCodes: [] },
    denominator: 17,
    requiredOnPath: 17,
  });
  expect(order[0]).toBe("correct");
  expect(
    report.mutants.filter(
      (item) => item.classification === "killed_by_behavioral_mismatch",
    ),
  ).toHaveLength(17);
  expect(
    report.mutants.every(
      (item) => !Object.keys(item).includes("rawEvaluation"),
    ),
  ).toBe(true);
});

test("Gate path executes the complete reviewed 17-mutant denominator", async () => {
  let calls = 0;
  const report = await runMutationCampaign(campaign, {
    path: "gate",
    observedProtected: campaign.protected,
    policy,
    evaluate: async (scenario) => {
      calls++;
      return gate(
        scenario.kind === "correct"
          ? pass()
          : mismatch(scenario.mutant!.expected),
      );
    },
  });
  expect(report.requiredOnPath).toBe(17);
  expect(
    report.mutants.filter((item) => item.disposition === "unsupported"),
  ).toHaveLength(0);
  expect(
    report.mutants.filter(
      (item) => item.classification === "killed_by_behavioral_mismatch",
    ),
  ).toHaveLength(17);
  expect(calls).toBe(18);
});

test("classification keeps survival, invalidity, infrastructure, and inconclusive outcomes distinct", async () => {
  let index = 0;
  const controls = [
    pass(),
    failed("configuration", "factory"),
    failed("transport"),
    failed("implementation"),
    mismatch(campaign.mutants[4]!.expected, "failed"),
    mismatch(campaign.mutants[5]!.expected, "succeeded", {
      status: "failed",
      code: "probe_failed",
    }),
  ];
  const report = await runMutationCampaign(campaign, {
    path: "local",
    observedProtected: campaign.protected,
    policy,
    evaluate: async (scenario) =>
      scenario.kind === "correct"
        ? pass()
        : (controls[index++] ?? mismatch(scenario.mutant!.expected)),
  });
  expect(report.mutants.slice(0, 6).map((item) => item.classification)).toEqual(
    [
      "survived",
      "invalid_mutant",
      "infrastructure_failure",
      "inconclusive",
      "inconclusive",
      undefined,
    ],
  );
  expect(report.status).toBe("incomplete");
});

test("protected drift and mutant cap refuse before the baseline evaluator", async () => {
  for (const mode of ["drift", "limit"] as const) {
    let calls = 0;
    const observed = structuredClone(campaign.protected) as any;
    if (mode === "drift") observed.model.sha256 = "f".repeat(64);
    await expect(
      runMutationCampaign(campaign, {
        path: "local",
        observedProtected: observed,
        policy: { ...policy, ...(mode === "limit" ? { maxMutants: 1 } : {}) },
        evaluate: async () => {
          calls++;
          return pass();
        },
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(0);
  }
});

test("baseline failure stops all mutant interpretation", async () => {
  let calls = 0;
  const report = await runMutationCampaign(campaign, {
    path: "local",
    observedProtected: campaign.protected,
    policy,
    evaluate: async () => {
      calls++;
      return failed("implementation");
    },
  });
  expect(report.status).toBe("baseline_failed");
  expect(calls).toBe(1);
  expect(report.mutants).toHaveLength(17);
  expect(report.mutants.every((item) => item.disposition !== "attempted")).toBe(
    true,
  );
});

test("Gate campaigns require nonempty, unique gate-physical cleanup evidence", async () => {
  for (const cleanup of [
    undefined,
    [],
    [
      {
        scope: "gate-physical" as const,
        requirement: "optional" as const,
        status: "confirmed" as const,
      },
    ],
    [
      {
        scope: "gate-physical" as const,
        requirement: "required" as const,
        status: "confirmed" as const,
      },
      {
        scope: "gate-physical" as const,
        requirement: "required" as const,
        status: "confirmed" as const,
      },
    ],
  ]) {
    let calls = 0;
    const report = await runMutationCampaign(campaign, {
      path: "gate",
      observedProtected: campaign.protected,
      policy,
      evaluate: async () => {
        calls++;
        return { ...pass(), ...(cleanup === undefined ? {} : { cleanup }) };
      },
    });
    expect(report.status).toBe("baseline_failed");
    expect(report.acceptance.status).toBe("incomplete");
    expect(calls).toBe(1);
  }
});

test("execution completion and campaign acceptance remain separate for survivors", async () => {
  let mutant = 0;
  const report = await runMutationCampaign(campaign, {
    path: "local",
    observedProtected: campaign.protected,
    policy,
    evaluate: async (scenario) => {
      if (scenario.kind === "correct") return pass();
      mutant++;
      return mutant === 1 ? pass() : mismatch(scenario.mutant!.expected);
    },
  });
  expect(report.status).toBe("complete");
  expect(report.acceptance).toEqual({
    status: "unmet",
    reasonCodes: ["required_mutant_survived"],
  });
});

test("protected drift after the baseline stops before mutant acquisition", async () => {
  let observations = 0;
  let evaluations = 0;
  const changed = structuredClone(campaign.protected) as any;
  changed.corpus.sha256 = "f".repeat(64);
  const report = await runMutationCampaign(campaign, {
    path: "local",
    observedProtected: campaign.protected,
    observeProtected: () =>
      ++observations === 1 ? campaign.protected : changed,
    policy,
    evaluate: async () => {
      evaluations++;
      return pass();
    },
  });
  expect(evaluations).toBe(1);
  expect(report).toMatchObject({
    status: "incomplete",
    acceptance: {
      status: "incomplete",
      reasonCodes: ["campaign_protected_drift"],
    },
  });
  expect(report.mutants.every((item) => item.disposition === "not_run")).toBe(
    true,
  );
});

test("timeout and cancellation are inconclusive and do not become kills", async () => {
  for (const kind of ["timeout", "cancel"] as const) {
    const controller = new AbortController();
    let calls = 0;
    const report = await runMutationCampaign(campaign, {
      path: "local",
      observedProtected: campaign.protected,
      signal: controller.signal,
      policy: { ...policy, perRunBudgetMs: 10 },
      evaluate: async (scenario) => {
        calls++;
        if (scenario.kind === "correct") return pass();
        if (kind === "cancel") controller.abort("stop");
        return new Promise((resolve) =>
          setTimeout(() => resolve(mismatch(scenario.mutant!.expected)), 25),
        );
      },
    });
    expect(
      report.mutants.find((item) => item.disposition === "attempted")
        ?.classification,
    ).toBe("inconclusive");
    expect(report.status).toBe(kind === "cancel" ? "cancelled" : "incomplete");
    expect(calls).toBe(2);
  }
});

test("actual protected assertion compares fixed bytes rather than a tautological fingerprint", () => {
  expect(() =>
    assertMutationProtectedInputs(campaign, campaign.protected),
  ).not.toThrow();
  const changed = structuredClone(campaign.protected) as any;
  changed.observer.sha256 = "f".repeat(64);
  expect(() => assertMutationProtectedInputs(campaign, changed)).toThrow();
});

test("never-settling protected identity observation is bounded before evaluator acquisition", async () => {
  let evaluations = 0;
  await expect(
    runMutationCampaign(campaign, {
      path: "local",
      observedProtected: campaign.protected,
      observeProtected: () => new Promise(() => {}),
      policy: { ...policy, perRunBudgetMs: 10 },
      evaluate: async () => {
        evaluations++;
        return pass();
      },
    }),
  ).rejects.toMatchObject({ code: "campaign_protected_timeout" });
  expect(evaluations).toBe(0);
});

test("protected identity observation timeout after baseline stops mutant acquisition", async () => {
  let observations = 0;
  let evaluations = 0;
  const report = await runMutationCampaign(campaign, {
    path: "local",
    observedProtected: campaign.protected,
    observeProtected: () =>
      ++observations === 1 ? campaign.protected : new Promise(() => {}),
    policy: { ...policy, perRunBudgetMs: 10 },
    evaluate: async () => {
      evaluations++;
      return pass();
    },
  });
  expect(evaluations).toBe(1);
  expect(report).toMatchObject({
    status: "incomplete",
    acceptance: {
      status: "incomplete",
      reasonCodes: ["campaign_protected_timeout"],
    },
  });
});
