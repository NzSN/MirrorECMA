import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  ReplayMismatchError,
  frameworkCatalogDigest,
  runMutationCampaign,
  runSuite,
  runSuiteWithFactory,
} from "../../dist/index.js";
import { root, run, sha256 } from "./regenerate.mjs";
import {
  instrumentApplicationAdapter,
  probeDefinitions,
  withObserverControl,
} from "./fidelity.mjs";

export function catalogIdentityFromUtf8(raw) {
  const document = JSON.parse(
    typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"),
  );
  return {
    document,
    digest: frameworkCatalogDigest(document),
  };
}

export async function loadApplication(folder, options = {}) {
  assert(
    ["persistent-transfer", "lease-service", "work-queue"].includes(folder),
    "unknown application",
  );
  const directory = join(root, "examples", folder);
  const app = JSON.parse(
    await readFile(join(directory, "application.json"), "utf8"),
  );
  const declared = await import(
    pathToFileURL(join(root, "dist-validation/examples", folder, "suite.js"))
  );
  const modelPath = join(directory, "specs", `${app.module}.tla`);
  const trace = join(directory, "artifacts/witness.itf.json");
  const paths = options.tracePaths ?? [trace, trace];
  const traces = await Promise.all(
    paths.map(async (path) => ({ path, sha256: await sha256(path) })),
  );
  const suite = declared.defineApplicationSuite(modelPath, traces);
  return {
    ...app,
    directory,
    trace,
    suite,
    model: suite.model,
    localFaults: app.localFaults ?? app.faults,
    publicManifest: suite.model.publicManifest,
    config: suite.replay.config,
  };
}

/** Generic providers and local adapters consume the same declared suite. */
export function runApplicationSuite(app, factory, options = {}) {
  return runSuiteWithFactory(
    app.suite,
    {
      mirror:
        options.mirror ??
        process.env.MIRROR_BIN ??
        resolve(root, "../Mirrors/.lake/build/bin/mirror"),
      signal: options.signal,
      timeouts: options.timeouts,
    },
    factory,
  );
}

export async function checkArtifacts(app, options = {}) {
  const dir = join(app.directory, "artifacts");
  const provenance = JSON.parse(
    await readFile(join(dir, "provenance.json"), "utf8"),
  );
  const contract = join(dir, `${app.module}.mirror-interface.json`);
  assert.equal(
    await sha256(app.config.specPath),
    provenance.modelSha256,
    "stale model witness",
  );
  assert.equal(await sha256(app.trace), provenance.traceSha256, "stale trace");
  if (provenance.contractSha256)
    assert.equal(
      await sha256(contract),
      provenance.contractSha256,
      "stale interface contract",
    );
  if (options.prevalidated) {
    assert.equal(
      options.prevalidated.status,
      "verified",
      "installed application closure was not independently verified",
    );
    const bundleManifest = join(dir, "bundle", ".suite-bundle-generated.json");
    const generated = JSON.parse(await readFile(bundleManifest, "utf8"));
    assert.equal(generated.schema, "mirrors.suite-bundle/v1");
    const files = new Set(generated.files);
    assert(files.has(".suite-bundle-generated.json"));
    for (const entry of generated.payloadSha256) {
      assert(files.has(entry.path), "bundle hash names an undeclared file");
      assert.equal(
        await sha256(join(dir, "bundle", entry.path)),
        entry.sha256,
        `stale installed bundle payload: ${entry.path}`,
      );
    }
    return;
  }
  const compiler =
    process.env.MODEL_INTERFACE_GEN ??
    resolve(root, "../Mirrors/.lake/build/bin/model_interface_gen");
  run(compiler, [
    "check-bundle",
    "--spec",
    app.config.specPath,
    "--contract",
    contract,
    "--evidence",
    app.trace,
    "--param-var",
    "parameters",
    "--lock",
    join(dir, `${app.module}.mirror-interface.lock.json`),
    "--target",
    "mirrorecma-async-v1",
    "--out",
    join(dir, "bundle"),
  ]);
  for (const trace of app.suite.replay.traces)
    run(compiler, [
      "preflight",
      "--lock",
      join(dir, `${app.module}.mirror-interface.lock.json`),
      "--trace",
      trace.path,
      "--require-all-actions",
    ]);
}

export async function evaluateLocal(app, variant, options = {}) {
  const scratch = await mkdtemp(join(tmpdir(), `${app.folder}-acceptance-`));
  const controller = new AbortController();
  let disposed = false,
    allocations = 0;
  let probe = { status: "not_run", code: "probe_not_started" };
  const started = performance.now();
  try {
    const suiteResult = await runSuite(app.suite, {
      mirror:
        options.mirror ??
        process.env.MIRROR_BIN ??
        resolve(root, "../Mirrors/.lake/build/bin/mirror"),
      signal: controller.signal,
      timeouts: {
        registrationMs: 30_000,
        actionMs: variant === "hang" ? 100 : 5_000,
        receiveMs: 30_000,
        cleanupMs: 5_000,
      },
      implementation: async (context) => {
        // Import application code and allocate the actual SUT only after admission.
        const module =
          app.folder === "work-queue" ? "native-service.mjs" : "service.mjs";
        const { createAdapter } = await import(
          pathToFileURL(join(app.directory, module))
        );
        const controlCase = ["crash", "hang", "cancel"].includes(variant);
        const created = await createAdapter(
          controlCase ? "correct" : variant,
          scratch,
        );
        const selected = options.observerControl
          ? withObserverControl(
              created,
              options.observerControl,
              options.shadowSnapshots,
            )
          : created;
        const fidelity = instrumentApplicationAdapter(app.folder, selected, {
          budgetMs: 1_000,
        });
        const adapter = fidelity.adapter;
        allocations++;
        const dispose = async () => {
          probe = await fidelity.result();
          await adapter.dispose();
          disposed = true;
        };
        context.deferCleanup(dispose);
        if (controlCase) {
          for (const operation of app.publicManifest.actions) {
            adapter.actions[operation.id] = async (_inputs, replayContext) => {
              if (variant === "crash")
                throw new Error("injected application failure");
              if (variant === "cancel")
                controller.abort("acceptance cancellation");
              return new Promise((_, reject) => {
                if (replayContext.signal.aborted)
                  reject(replayContext.signal.reason);
                else
                  replayContext.signal.addEventListener(
                    "abort",
                    () => reject(replayContext.signal.reason),
                    { once: true },
                  );
              });
            };
          }
        }
        return { port: adapter, dispose };
      },
    });
    const remaining = await readdir(scratch);
    const cleanup = {
      kind: "local-resource-census",
      status:
        allocations === 1 &&
        disposed &&
        remaining.length === 0 &&
        suiteResult.cleanup.status === "succeeded" &&
        suiteResult.cleanup.quiescence === "confirmed"
          ? "confirmed"
          : "failed",
      remainingEntries: remaining,
    };
    const failure =
      suiteResult.trustedError instanceof ReplayMismatchError
        ? suiteResult.trustedError.toJSON()
        : suiteResult.failure;
    return {
      variant,
      classification: suiteResult.outcome,
      durationMs: performance.now() - started,
      allocations,
      suiteResult,
      actionCounts: suiteResult.evidence.actionCounts,
      sequenceCounts: suiteResult.evidence.pairCounts,
      cleanup,
      probe,
      failure,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function runLocalAcceptance(app, options = {}) {
  if (options.tracePaths) app = await loadApplication(app.folder, options);
  await checkArtifacts(app, options);
  const results = [];
  const check = (variant, result) => {
    assert.equal(
      result.cleanup.status,
      "confirmed",
      `${variant}: local cleanup failed: ${JSON.stringify(result)}`,
    );
    if (variant === "correct") {
      assert.equal(result.classification, "passed", JSON.stringify(result));
      assert.equal(result.suiteResult.acceptance.status, "met");
      assert.equal(result.suiteResult.evidence.tracesCompleted, 2);
      assert.equal(result.suiteResult.evidence.initializationsMatched, "2");
      assert.equal(
        result.suiteResult.evidence.transitionsMatched,
        String(2 * app.length),
      );
      for (const operation of app.publicManifest.actions)
        assert(BigInt(result.actionCounts[operation.id]) > 0n);
    } else if (app.localFaults[variant]) {
      const expected = app.localFaults[variant];
      assert.equal(
        result.classification,
        "mismatch",
        `${variant}: not a behavioral mismatch: ${JSON.stringify(result)}`,
      );
      assert.equal(result.failure.action, expected.action);
      assert.equal(result.failure.stateIndex, expected.step);
      assert.equal(result.failure.traceIndex, expected.trace ?? 0);
      result.expectedFirstMismatch = {
        code: "replay_mismatch",
        traceIndex: expected.trace ?? 0,
        stateIndex: expected.step,
        action: expected.action,
      };
    } else
      assert.equal(
        result.classification,
        { crash: "failed", hang: "timedOut", cancel: "cancelled" }[variant],
      );
  };
  const digestJson = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const closureSha = async (paths) =>
    digestJson(
      await Promise.all(
        [...paths]
          .sort()
          .map(async (path) => ({ path, sha256: await sha256(path) })),
      ),
    );
  const fidelityPath = fileURLToPath(
    new URL("./fidelity.mjs", import.meta.url),
  );
  const implementationFiles =
    app.folder === "work-queue"
      ? [
          join(app.directory, "queue.ts"),
          join(app.directory, "native-service.mjs"),
          join(app.directory, "queue-fixture.mjs"),
          join(app.directory, "validation-faults.mjs"),
        ]
      : [join(app.directory, "service.mjs")];
  const observerFiles =
    app.folder === "work-queue"
      ? [join(app.directory, "queue-fixture.mjs")]
      : [join(app.directory, "service.mjs")];
  const implementationSha = await closureSha(implementationFiles);
  const observerSha = await closureSha(observerFiles);
  const probeSha = await closureSha([...observerFiles, fidelityPath]);
  const probeId = {
    "work-queue": "persisted-queue-json/v1",
    "persistent-transfer": "transfer-payload-journal/v1",
    "lease-service": "lease-ownership-token-writes/v1",
  }[app.folder];
  const mirror =
    options.mirror ??
    process.env.MIRROR_BIN ??
    resolve(root, "../Mirrors/.lake/build/bin/mirror");
  const catalogRaw = options.prevalidated?.catalogRaw !== undefined
    ? Buffer.from(options.prevalidated.catalogRaw, "utf8")
    : await readFile(
        process.env.MIRRORS_CATALOG ??
          resolve(root, "../Mirrors/catalog/framework-catalog.json"),
      );
  const catalogIdentity = catalogIdentityFromUtf8(catalogRaw);
  if (options.prevalidated?.catalogSelectionRef !== undefined)
    assert.equal(
      catalogIdentity.digest,
      options.prevalidated.catalogSelectionRef.selectionValue,
      "installed framework catalog bytes drifted",
    );
  const generatedInterfaceSha = await closureSha([
    join(app.directory, "artifacts", "bundle", `${app.module}.suite.ts`),
    join(
      root,
      "dist-validation",
      "examples",
      app.folder,
      "artifacts",
      "bundle",
      `${app.module}.suite.js`,
    ),
    join(app.directory, "artifacts", "bundle", ".suite-bundle-generated.json"),
  ]);
  const protectedInputs = {
    suite: {
      id: app.suite.id,
      sha256: digestJson({
        id: app.suite.id,
        replay: app.suite.replay,
        acceptance: app.suite.acceptance,
      }),
    },
    model: {
      id: `${app.folder}.model/v1`,
      sha256: await sha256(app.config.specPath),
    },
    generatedInterface: {
      id: `${app.folder}.interface/v1`,
      sha256: generatedInterfaceSha,
    },
    corpus: {
      id: `${app.folder}.ordered-corpus/v1`,
      sha256: digestJson(app.suite.replay.traces.map((trace) => trace.sha256)),
    },
    acceptance: {
      id: `${app.folder}.acceptance/v1`,
      sha256: digestJson(app.suite.acceptance),
    },
    observer: { id: `${app.folder}.observer/v1`, sha256: observerSha },
    correctImplementation: {
      id: `${app.folder}/correct`,
      sha256: implementationSha,
    },
    probes: [
      {
        id: probeId,
        sha256: digestJson({
          definition: probeDefinitions[probeId],
          executableClosureSha256: probeSha,
        }),
      },
    ],
    executionProfiles: [
      {
        id: "local-suite/v1",
        sha256: digestJson({
          mirrorSha256: await sha256(mirror),
          node: process.version,
          harnessSha256: await sha256(fileURLToPath(import.meta.url)),
        }),
      },
    ],
  };
  const campaign = {
    schema: "mirrorecma.mutation-campaign/v1",
    id: app.mutationCampaign.id,
    revision: app.mutationCampaign.revision,
    evidenceLinks: {
      catalogSelectionRef: {
        schemaVersion: "mirrors.framework-catalog/v1",
        selectionKind: "sha256",
        selectionValue: catalogIdentity.digest,
      },
    },
    denominator: app.mutationCampaign.denominator,
    protected: protectedInputs,
    mutants: app.mutationCampaign.mutants.map((mutant) => ({
      ...mutant,
      implementation: {
        id: `${app.folder}/${mutant.id}`,
        sha256: digestJson({ implementationSha, variant: mutant.id }),
      },
      resetPlanId: `${app.folder}.fresh-factory/v1`,
      probeIds: [probeId],
    })),
  };
  const mutationCampaign = await runMutationCampaign(campaign, {
    path: "local",
    observedProtected: protectedInputs,
    policy: {
      maxMutants: 256,
      totalBudgetMs: 300_000,
      perRunBudgetMs: 30_000,
      cleanupBudgetMs: 5_000,
    },
    evaluate: async (scenario) => {
      const variant = scenario.kind === "correct" ? "correct" : scenario.id;
      const result = await evaluateLocal(app, variant, options);
      results.push(result);
      check(variant, result);
      return { suiteResult: result.suiteResult, probe: result.probe };
    },
  });
  assert.equal(
    mutationCampaign.status,
    "complete",
    JSON.stringify(mutationCampaign),
  );
  assert.equal(
    mutationCampaign.acceptance.status,
    "met",
    JSON.stringify(mutationCampaign),
  );
  for (const variant of ["crash", "hang", "cancel"]) {
    const result = await evaluateLocal(app, variant, options);
    results.push(result);
    check(variant, result);
  }
  return {
    schema: "mirrorecma.application-validation/v2",
    application: app.folder,
    suiteId: app.suite.id,
    tier: options.tracePaths
      ? "fresh-deterministic-witness"
      : "checked-deterministic-witness",
    generatedAt: new Date().toISOString(),
    node: process.version,
    identities: {
      model: await sha256(app.config.specPath),
      implementation: await sha256(
        join(
          app.directory,
          app.folder === "work-queue" ? "queue.ts" : "service.mjs",
        ),
      ),
      harness: await sha256(fileURLToPath(import.meta.url)),
      interface: app.model.semanticDigest,
      applicationConfig: await sha256(join(app.directory, "application.json")),
      mirror: await sha256(mirror),
      trace: await sha256(options.tracePaths?.[0] ?? app.trace),
    },
    mutationCampaign: {
      id: mutationCampaign.campaignId,
      revision: mutationCampaign.revision,
      status: mutationCampaign.status,
      acceptance: mutationCampaign.acceptance,
      denominator: mutationCampaign.denominator,
      requiredOnPath: mutationCampaign.requiredOnPath,
      results: mutationCampaign.mutants.map((result) => ({
        id: result.id,
        classification: result.classification,
        disposition: result.disposition,
        cleanup: result.cleanup,
        probe: result.probe,
      })),
    },
    measurements: {
      setupTime: "not measured",
      diagnosisTime: "not measured",
      evaluationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    },
    results,
  };
}
