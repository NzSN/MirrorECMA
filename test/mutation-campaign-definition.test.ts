import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  MutationCampaignError,
  assertMutationProtectedInputs,
  decodeMutationCampaign,
  validateMutationCampaign,
} from "../src/mutation-campaign.js";

const fixtureRoot = resolve("test/fixtures/mutation-campaign");
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
async function current() {
  return decodeMutationCampaign(
    await readFile(
      join(fixtureRoot, "accepted/current-17-local-17-gate.json"),
      "utf8",
    ),
    { knownActions },
  );
}

test("production validator fixes all 17 mutants on local and Gate paths", async () => {
  const campaign = await current();
  expect(campaign.mutants).toHaveLength(17);
  expect(
    campaign.mutants.filter(
      (mutant) => mutant.paths.local.support === "required",
    ),
  ).toHaveLength(17);
  expect(
    campaign.mutants.filter(
      (mutant) => mutant.paths.gate.support === "required",
    ),
  ).toHaveLength(17);
  expect(
    campaign.mutants.filter(
      (mutant) => mutant.paths.gate.support === "unsupported",
    ),
  ).toHaveLength(0);
});

test("application declarations are exact projections of the protected campaign matrix", async () => {
  const campaign = await current();
  for (const application of [
    "work-queue",
    "persistent-transfer",
    "lease-service",
  ]) {
    const app = JSON.parse(
      await readFile(
        resolve(`examples/${application}/application.json`),
        "utf8",
      ),
    );
    const selected = campaign.mutants.filter((mutant) =>
      mutant.id.startsWith(`${application}/`),
    );
    expect(app.mutationCampaign.denominator).toBe(selected.length);
    expect(app.mutationCampaign.mutants).toEqual(
      selected.map((mutant) => ({
        id: mutant.id.slice(application.length + 1),
        expected: mutant.expected,
        paths: mutant.paths,
      })),
    );
  }
});

test("all WorkQueue Gate rows resolve through the shared frozen fault constructors", async () => {
  const campaign = await current();
  const source = await readFile(
    resolve("examples/work-queue/validation-faults.mjs"),
    "utf8",
  );
  for (const mutant of campaign.mutants.filter((entry) =>
    entry.id.startsWith("work-queue/"),
  )) {
    const name = mutant.id.slice("work-queue/".length);
    expect(mutant.paths.gate.support).toBe("required");
    expect(source.includes(`"${name}"`)).toBe(true);
  }
});

test("production protected-input assertion rejects every identity category before execution", async () => {
  const campaign = await current();
  for (const key of Object.keys(
    campaign.protected,
  ) as (keyof typeof campaign.protected)[]) {
    const changed = structuredClone(campaign.protected) as any;
    if (Array.isArray(changed[key])) changed[key][0].sha256 = "f".repeat(64);
    else changed[key].sha256 = "f".repeat(64);
    expect(() => assertMutationProtectedInputs(campaign, changed)).toThrow(
      expect.objectContaining({ code: "campaign_protected_drift" }),
    );
  }
});

test("all rejected campaign fixtures fail the production validator", async () => {
  const names = await readdir(join(fixtureRoot, "rejected"));
  expect(names).toHaveLength(6);
  for (const name of names) {
    const raw = await readFile(join(fixtureRoot, "rejected", name), "utf8");
    expect(() => decodeMutationCampaign(raw, { knownActions })).toThrow(
      MutationCampaignError,
    );
  }
});

test("every mutant probe ID must resolve to the protected probe set", async () => {
  const raw = JSON.parse(
    await readFile(
      join(fixtureRoot, "accepted/current-17-local-17-gate.json"),
      "utf8",
    ),
  );
  raw.mutants[0].probeIds = ["unprotected-probe/v1"];
  expect(() => validateMutationCampaign(raw, { knownActions })).toThrow(
    expect.objectContaining({ code: "campaign_probe_invalid" }),
  );
});

test("duplicate JSON keys and accessors fail without invoking user code", async () => {
  const raw = await readFile(
    join(fixtureRoot, "accepted/current-17-local-17-gate.json"),
    "utf8",
  );
  expect(() =>
    decodeMutationCampaign(`{"schema":"duplicate",${raw.slice(1)}`, {
      knownActions,
    }),
  ).toThrow(expect.objectContaining({ code: "bundle_duplicate_key" }));
  const value = JSON.parse(raw);
  let invoked = false;
  Object.defineProperty(value, "id", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("getter ran");
    },
  });
  expect(() => validateMutationCampaign(value, { knownActions })).toThrow(
    expect.objectContaining({ code: "campaign_non_data_property" }),
  );
  expect(invoked).toBe(false);
});

test("optional E1 campaign references use the shared strict validators", async () => {
  const campaignValue = JSON.parse(
    await readFile(
      join(fixtureRoot, "accepted/current-17-local-17-gate.json"),
      "utf8",
    ),
  );
  const reproduction = JSON.parse(
    await readFile(
      resolve("test/fixtures/reproduction/accepted/behavioral-mismatch.json"),
      "utf8",
    ),
  );
  campaignValue.evidenceLinks.runRef = structuredClone(
    reproduction.evidenceLinks.runRef,
  );
  campaignValue.evidenceLinks.artifactRefs =
    reproduction.evidenceLinks.artifactRefs;
  expect(() =>
    validateMutationCampaign(campaignValue, { knownActions }),
  ).not.toThrow();
  campaignValue.evidenceLinks.runRef.projectionKind = "public";
  expect(() =>
    validateMutationCampaign(campaignValue, { knownActions }),
  ).toThrow();
  campaignValue.evidenceLinks.runRef = structuredClone(
    reproduction.evidenceLinks.runRef,
  );
  campaignValue.evidenceLinks.artifactRefs.push({
    ...campaignValue.evidenceLinks.artifactRefs[0],
    sha256: "f".repeat(64),
  });
  expect(() =>
    validateMutationCampaign(campaignValue, { knownActions }),
  ).toThrow(expect.objectContaining({ code: "evidence_ref_invalid" }));
});
