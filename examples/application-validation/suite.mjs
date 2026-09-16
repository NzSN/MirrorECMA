import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ReplayMismatchError, runSuite, runSuiteWithFactory } from '../../dist/index.js';
import { root, run, sha256 } from './regenerate.mjs';

export async function loadApplication(folder, options = {}) {
  assert(['persistent-transfer', 'lease-service', 'work-queue'].includes(folder), 'unknown application');
  const directory = join(root, 'examples', folder);
  const app = JSON.parse(await readFile(join(directory, 'application.json'), 'utf8'));
  const declared = await import(pathToFileURL(join(root, 'dist-validation/examples', folder, 'suite.js')));
  const modelPath = join(directory, 'specs', `${app.module}.tla`);
  const trace = join(directory, 'artifacts/witness.itf.json');
  const paths = options.tracePaths ?? [trace, trace];
  const traces = await Promise.all(paths.map(async path => ({path, sha256: await sha256(path)})));
  const suite = declared.defineApplicationSuite(modelPath, traces);
  return {...app, directory, trace, suite, model: suite.model,
    localFaults: app.localFaults ?? app.faults,
    publicManifest: suite.model.publicManifest, config: suite.replay.config};
}

/** Generic providers and local adapters consume the same declared suite. */
export function runApplicationSuite(app, factory, options = {}) {
  return runSuiteWithFactory(app.suite, {
    mirror: options.mirror ?? process.env.MIRROR_BIN ?? resolve(root, '../Mirrors/.lake/build/bin/mirror'),
    signal: options.signal, timeouts: options.timeouts,
  }, factory);
}

export async function checkArtifacts(app) {
  const dir = join(app.directory, 'artifacts');
  const provenance = JSON.parse(await readFile(join(dir, 'provenance.json'), 'utf8'));
  const contract = join(dir, `${app.module}.mirror-interface.json`);
  assert.equal(await sha256(app.config.specPath), provenance.modelSha256, 'stale model witness');
  assert.equal(await sha256(app.trace), provenance.traceSha256, 'stale trace');
  if (provenance.contractSha256) assert.equal(await sha256(contract), provenance.contractSha256, 'stale interface contract');
  const compiler = process.env.MODEL_INTERFACE_GEN ?? resolve(root, '../Mirrors/.lake/build/bin/model_interface_gen');
  run(compiler, ['check-bundle', '--spec', app.config.specPath, '--contract', contract, '--evidence', app.trace,
    '--param-var', 'parameters', '--lock', join(dir, `${app.module}.mirror-interface.lock.json`),
    '--target', 'mirrorecma-async-v1', '--out', join(dir, 'bundle')]);
  for (const trace of app.suite.replay.traces) run(compiler, ['preflight',
    '--lock', join(dir, `${app.module}.mirror-interface.lock.json`), '--trace', trace.path, '--require-all-actions']);
}

export async function evaluateLocal(app, variant, options = {}) {
  const scratch = await mkdtemp(join(tmpdir(), `${app.folder}-acceptance-`));
  const controller = new AbortController();
  let disposed = false, allocations = 0;
  const started = performance.now();
  try {
    const suiteResult = await runSuite(app.suite, {
      mirror: options.mirror ?? process.env.MIRROR_BIN ?? resolve(root, '../Mirrors/.lake/build/bin/mirror'),
      signal: controller.signal,
      timeouts: {registrationMs: 30_000, actionMs: variant === 'hang' ? 100 : 5_000,
        receiveMs: 30_000, cleanupMs: 5_000},
      implementation: async context => {
        // Import application code and allocate the actual SUT only after admission.
        const module = app.folder === 'work-queue' ? 'native-service.mjs' : 'service.mjs';
        const {createAdapter} = await import(pathToFileURL(join(app.directory, module)));
        const controlCase = ['crash', 'hang', 'cancel'].includes(variant);
        const adapter = await createAdapter(controlCase ? 'correct' : variant, scratch);
        allocations++;
        const dispose = async () => { await adapter.dispose(); disposed = true; };
        context.deferCleanup(dispose);
        if (controlCase) {
          for (const operation of app.publicManifest.actions) {
            adapter.actions[operation.id] = async (_inputs, replayContext) => {
              if (variant === 'crash') throw new Error('injected application failure');
              if (variant === 'cancel') controller.abort('acceptance cancellation');
              return new Promise((_, reject) => {
                if (replayContext.signal.aborted) reject(replayContext.signal.reason);
                else replayContext.signal.addEventListener('abort', () => reject(replayContext.signal.reason), {once: true});
              });
            };
          }
        }
        return {port: adapter, dispose};
      },
    });
    const remaining = await readdir(scratch);
    const cleanup = {kind: 'local-resource-census', status: allocations === 1 && disposed && remaining.length === 0
      && suiteResult.cleanup.status === 'succeeded' && suiteResult.cleanup.quiescence === 'confirmed' ? 'confirmed' : 'failed',
      remainingEntries: remaining};
    const failure = suiteResult.trustedError instanceof ReplayMismatchError
      ? suiteResult.trustedError.toJSON() : suiteResult.failure;
    return {variant, classification: suiteResult.outcome, durationMs: performance.now() - started, allocations,
      suiteResult, actionCounts: suiteResult.evidence.actionCounts,
      sequenceCounts: suiteResult.evidence.pairCounts, cleanup, failure};
  } finally { await rm(scratch, {recursive: true, force: true}); }
}

export async function runLocalAcceptance(app, options = {}) {
  if (options.tracePaths) app = await loadApplication(app.folder, options);
  await checkArtifacts(app);
  const results = [];
  for (const variant of ['correct', ...Object.keys(app.localFaults), 'crash', 'hang', 'cancel']) {
    const result = await evaluateLocal(app, variant, options);
    results.push(result);
    assert.equal(result.cleanup.status, 'confirmed', `${variant}: local cleanup failed: ${JSON.stringify(result)}`);
    if (variant === 'correct') {
      assert.equal(result.classification, 'passed', JSON.stringify(result));
      assert.equal(result.suiteResult.acceptance.status, 'met');
      assert.equal(result.suiteResult.evidence.tracesCompleted, 2);
      assert.equal(result.suiteResult.evidence.initializationsMatched, '2');
      assert.equal(result.suiteResult.evidence.transitionsMatched, String(2 * app.length));
      for (const operation of app.publicManifest.actions) assert(BigInt(result.actionCounts[operation.id]) > 0n);
    } else if (app.localFaults[variant]) {
      const expected = app.localFaults[variant];
      assert.equal(result.classification, 'mismatch', `${variant}: not a behavioral mismatch: ${JSON.stringify(result)}`);
      assert.equal(result.failure.action, expected.action);
      assert.equal(result.failure.stateIndex, expected.step);
      assert.equal(result.failure.traceIndex, expected.trace ?? 0);
      result.expectedFirstMismatch = {code: 'replay_mismatch', traceIndex: expected.trace ?? 0,
        stateIndex: expected.step, action: expected.action};
    } else assert.equal(result.classification, {crash: 'failed', hang: 'timedOut', cancel: 'cancelled'}[variant]);
  }
  const mirror = options.mirror ?? process.env.MIRROR_BIN ?? resolve(root, '../Mirrors/.lake/build/bin/mirror');
  return {schema: 'mirrorecma.application-validation/v2', application: app.folder,
    suiteId: app.suite.id,
    tier: options.tracePaths ? 'fresh-deterministic-witness' : 'checked-deterministic-witness',
    generatedAt: new Date().toISOString(), node: process.version,
    identities: {model: await sha256(app.config.specPath),
      implementation: await sha256(join(app.directory, app.folder === 'work-queue' ? 'queue.ts' : 'service.mjs')),
      harness: await sha256(fileURLToPath(import.meta.url)), interface: app.model.semanticDigest,
      applicationConfig: await sha256(join(app.directory, 'application.json')),
      mirror: await sha256(mirror), trace: await sha256(options.tracePaths?.[0] ?? app.trace)},
    measurements: {setupTime: 'not measured', diagnosisTime: 'not measured',
      evaluationMs: results.reduce((sum, result) => sum + result.durationMs, 0)}, results};
}
