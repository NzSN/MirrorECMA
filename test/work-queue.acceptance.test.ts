import { runQueueAcceptance } from "../examples/work-queue/acceptance.js";

test("the witness rejects every seeded fault at its pinned first mismatch", async () => {
  const { scenarios, correctReport, receipt } = await runQueueAcceptance({ receiveTimeoutMs: 30_000 });

  expect(correctReport.status).toBe("passed");
  expect(correctReport.tracesCompleted).toBe(2);
  expect(scenarios.map((scenario) => scenario.fault)).toEqual([
    "duplicate-accepts", "enqueue-drops", "enqueue-in-flight", "start-stale",
    "fail-does-not-mark", "retry-does-not-clear", "complete-keeps-in-flight", "complete-stale", "reset-leaves-state",
  ]);
  for (const scenario of scenarios) {
    expect(scenario.accepted).toBe(true);
    expect(scenario.firstMismatch?.code).toBe("step_mismatch");
  }
  expect(scenarios.map((scenario) => [scenario.fault, scenario.firstMismatch?.traceIndex,
    scenario.firstMismatch?.stateIndex, scenario.firstMismatch?.action]))
    .toEqual([
      ["duplicate-accepts", 1, 2, "enqueue"],
      ["enqueue-drops", 1, 1, "enqueue"],
      ["enqueue-in-flight", 1, 5, "enqueue"],
      ["start-stale", 1, 4, "start"],
      ["fail-does-not-mark", 1, 6, "fail"],
      ["retry-does-not-clear", 1, 7, "retry"],
      ["complete-keeps-in-flight", 1, 8, "complete"],
      ["complete-stale", 1, 8, "complete"],
      ["reset-leaves-state", 2, 0, "init"],
    ]);
  expect(receipt.cleanup.remainingEntries).toEqual([]);
  expect(receipt.controls.map(({ code }) => code)).toEqual(["adapter_failure", "action_timeout", "replay_aborted"]);
}, 120_000);
