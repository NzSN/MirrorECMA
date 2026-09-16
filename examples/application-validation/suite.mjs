import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { AsyncCompiledAdapterRegistry, ReplayMismatchError, ReplayCancelledError,
  ReplayDeadlineError, replayCleanupFailure, semanticDigestFromHex,
  runClientWithTracesNegotiatedWithReport } from '../../dist/index.js';
import { root, run, sha256 } from './regenerate.mjs';

export async function loadApplication(folder) {
  assert(['persistent-transfer', 'lease-service', 'work-queue'].includes(folder), 'unknown application');
  const directory = join(root, 'examples', folder);
  const app = JSON.parse(await readFile(join(directory, 'application.json'), 'utf8'));
  const generated = await import(pathToFileURL(join(root, 'dist-validation/examples', folder,
    'artifacts', app.generatedDirectory ?? 'generated', `${app.module}Mirror.generated.js`)));
  return { ...app, directory, generated,
    metadata: generated[`${app.module}ModelInterface`],
    publicManifest: generated[`${app.module}PublicManifest`],
    bindPublicPort: generated[`bind${app.module}AsyncPublicPort`],
    key: { semanticDigest: semanticDigestFromHex(generated[`${app.module}SemanticDigest`]),
      adapterId: `${folder}.validation/v1`, targetProfile: 'mirrorecma-async-v1',
      stateComputerContractVersion: 'mirrors.async-state-computer/v1' },
    config: { specPath: join(directory, 'specs', `${app.module}.tla`), initPredicate: 'Init',
      nextPredicate: 'WitnessNext', invariant: 'TraceComplete', lengthBound: app.length, paramVars: 'parameters' },
    trace: join(directory, 'artifacts/witness.itf.json'),
  };
}

/** Shared suite for local factories and Gate's deferred provider.factory. */
export function runApplicationSuite(app, factory, options = {}) {
  return runClientWithTracesNegotiatedWithReport(
    options.mirror ?? process.env.MIRROR_BIN ?? resolve(root, '../Mirrors/.lake/build/bin/mirror'),
    app.config, options.tracePaths ?? [app.trace, app.trace],
    { execution: 'async', mode: 'compiled', request: 'verify', policy: 'require', metadata: app.metadata,
      ...app.key, registry: new AsyncCompiledAdapterRegistry([{ key: app.key, factory }]) },
    { signal: options.signal, deadlines: options.deadlines ?? { registrationMs: 30_000, stepMs: 5_000, receiveMs: 30_000 } },
  );
}

export function classify(error) {
  if (error === undefined) return 'passed';
  if (error instanceof ReplayMismatchError) return 'mismatch';
  if (error instanceof ReplayCancelledError) return 'cancelled';
  if (error instanceof ReplayDeadlineError) return 'timeout';
  return 'infrastructure-error';
}

export async function checkArtifacts(app) {
  const dir = join(app.directory, 'artifacts');
  const provenance = JSON.parse(await readFile(join(dir, 'provenance.json'), 'utf8'));
  const contract = join(dir, `${app.module}.mirror-interface.json`);
  assert.equal(await sha256(app.config.specPath), provenance.modelSha256, 'stale model witness');
  assert.equal(await sha256(app.trace), provenance.traceSha256, 'stale trace');
  if (provenance.contractSha256) assert.equal(await sha256(contract), provenance.contractSha256, 'stale interface contract');
  const compiler = process.env.MODEL_INTERFACE_GEN ?? resolve(root, '../Mirrors/.lake/build/bin/model_interface_gen');
  run(compiler, ['check', '--spec', app.config.specPath, '--contract', contract, '--evidence', app.trace,
    '--param-var', 'parameters', '--lock', join(dir, `${app.module}.mirror-interface.lock.json`),
    '--target', 'mirrorecma-async-v1', '--out', join(dir, app.generatedDirectory ?? 'generated')]);
  run(compiler, ['preflight', '--lock', join(dir, `${app.module}.mirror-interface.lock.json`),
    '--trace', app.trace, '--require-all-actions']);
}

export async function evaluateLocal(app, variant, options = {}) {
  const scratch = await mkdtemp(join(tmpdir(), `${app.folder}-acceptance-`));
  const { createAdapter } = await import(pathToFileURL(join(app.directory, 'service.mjs')));
  const controller = new AbortController();
  const counts = {}, pairs = {};
  let previous, disposed = false, allocations = 0, error, report;
  const started = performance.now();
  try {
    const factory = async config => {
      allocations++;
      const adapter = await createAdapter(variant, scratch);
      const port = {
        invoke: async (id, inputs, context) => {
          if (id !== 'Initialize' && variant === 'crash') throw new Error('injected application failure');
          if (id !== 'Initialize' && ['hang', 'cancel'].includes(variant)) {
            if (variant === 'cancel') controller.abort('acceptance cancellation');
            return new Promise((_, reject) => {
              if (context.signal.aborted) reject(context.signal.reason);
              else context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
            });
          }
          await adapter.actions[id](inputs);
          counts[id] = (counts[id] ?? 0) + 1;
          if (id === 'Initialize') previous = undefined;
          if (previous) { const pair = `${previous}->${id}`; pairs[pair] = (pairs[pair] ?? 0) + 1; }
          previous = id;
        },
        observe: async () => {
          const native = await adapter.observe();
          // Generated TS ports use array-shaped sets; the Gate worker uses native Set.
          return Object.fromEntries(Object.entries(native).map(([key, value]) => [key, value instanceof Set ? [...value] : value]));
        },
      };
      const binding = app.bindPublicPort(port, config);
      return { ...binding, semanticDigest: app.key.semanticDigest,
        dispose: async () => { await adapter.dispose(); disposed = true; } };
    };
    try {
      report = await runApplicationSuite(app, factory, { ...options, signal: controller.signal,
        deadlines: { registrationMs: 30_000, stepMs: variant === 'hang' ? 100 : 5_000, receiveMs: 30_000 } });
    } catch (caught) { error = caught; }
    const remaining = await readdir(scratch);
    const cleanup = { kind: 'local-resource-census', status: allocations === 1 && disposed && remaining.length === 0
      && replayCleanupFailure(error) === undefined ? 'confirmed' : 'failed', remainingEntries: remaining };
    return { variant, classification: classify(error), durationMs: performance.now() - started, allocations,
      report, actionCounts: counts, sequenceCounts: pairs, cleanup,
      failure: error instanceof ReplayMismatchError ? error.toJSON() : error ? { code: error.code, message: error.message } : undefined };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function runLocalAcceptance(app, options = {}) {
  await checkArtifacts(app);
  const results = [];
  for (const variant of ['correct', ...Object.keys(app.faults), 'crash', 'hang', 'cancel']) {
    const result = await evaluateLocal(app, variant, options);
    results.push(result);
    assert.equal(result.cleanup.status, 'confirmed', `${variant}: local cleanup failed`);
    if (variant === 'correct') {
      assert.equal(result.classification, 'passed', JSON.stringify(result));
      assert.equal(result.report.acceptedTraces, 2);
      assert.equal(result.report.acceptedSteps, 2 * app.length);
      for (const operation of [...app.publicManifest.initializers, ...app.publicManifest.actions]) {
        assert(result.actionCounts[operation.id] > 0, `missing action ${operation.id}`);
      }
    } else if (app.faults[variant]) {
      assert.equal(result.classification, 'mismatch', `${variant}: not a behavioral mismatch: ${JSON.stringify(result)}`);
      assert.equal(result.failure.action, app.faults[variant].action);
      assert.equal(result.failure.stateIndex, app.faults[variant].step);
      assert.equal(result.failure.traceIndex, 0);
      result.expectedFirstMismatch = { code: 'replay_mismatch', traceIndex: 0,
        stateIndex: app.faults[variant].step, action: app.faults[variant].action };
    } else assert.equal(result.classification, { crash: 'infrastructure-error', hang: 'timeout', cancel: 'cancelled' }[variant]);
  }
  const mirror = options.mirror ?? process.env.MIRROR_BIN ?? resolve(root, '../Mirrors/.lake/build/bin/mirror');
  return { schema: 'mirrorecma.application-validation/v1', application: app.folder,
    tier: options.tracePaths ? 'fresh-deterministic-witness' : 'checked-deterministic-witness',
    generatedAt: new Date().toISOString(), node: process.version,
    identities: { model: await sha256(app.config.specPath), implementation: await sha256(join(app.directory, 'service.mjs')),
      harness: await sha256(fileURLToPath(import.meta.url)), interface: app.key.semanticDigest,
      applicationConfig: await sha256(join(app.directory, 'application.json')),
      mirror: await sha256(mirror), trace: await sha256(options.tracePaths?.[0] ?? app.trace) },
    measurements: { setupTime: 'not measured', diagnosisTime: 'not measured',
      evaluationMs: results.reduce((sum, result) => sum + result.durationMs, 0) }, results };
}
