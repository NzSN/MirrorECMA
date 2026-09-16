import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function run(command, args, expected = 0) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
export const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');

/** Real Apalache output only; --output writes fresh evidence without replacing fixtures. */
export async function generate(folder, destination) {
  assert(['persistent-transfer', 'lease-service', 'work-queue'].includes(folder), 'unknown application');
  assert(folder !== 'work-queue' || destination, 'WorkQueue regeneration here requires --output; preserve its established synchronous artifacts');
  const appRoot = join(root, 'examples', folder);
  const app = JSON.parse(await readFile(join(appRoot, 'application.json'), 'utf8'));
  const artifacts = destination ? resolve(destination) : join(appRoot, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const spec = join(appRoot, 'specs', `${app.module}.tla`);
  const contract = join(appRoot, 'artifacts', `${app.module}.mirror-interface.json`);
  const compiler = process.env.MODEL_INTERFACE_GEN ?? resolve(root, '../Mirrors/.lake/build/bin/model_interface_gen');
  const apalache = process.env.APALACHE_MC ?? 'apalache-mc';
  const scratch = await mkdtemp(join(tmpdir(), 'application-model-'));
  try {
    const version = run(apalache, ['version']).trim();
    const flags = ['check', '--init=Init', '--next=WitnessNext', '--inv=TraceComplete',
      `--length=${app.length}`, '--view=View', spec];
    run(apalache, [`--out-dir=${join(scratch, 'out')}`, `--run-dir=${join(scratch, 'witness')}`, ...flags], 12);
    const trace = join(artifacts, 'witness.itf.json');
    await copyFile(join(scratch, 'witness/violation1.itf.json'), trace);
    const lock = join(artifacts, `${app.module}.mirror-interface.lock.json`);
    run(compiler, ['resolve', '--spec', spec, '--contract', contract, '--evidence', trace,
      '--param-var', 'parameters', '--lock', lock]);
    run(compiler, ['generate', '--lock', lock, '--target', 'mirrorecma-async-v1', '--out', join(artifacts, 'generated')]);
    run(compiler, ['check', '--spec', spec, '--contract', contract, '--evidence', trace,
      '--param-var', 'parameters', '--lock', lock, '--target', 'mirrorecma-async-v1', '--out', join(artifacts, 'generated')]);
    run(compiler, ['preflight', '--lock', lock, '--trace', trace, '--require-all-actions']);
    const states = JSON.parse(await readFile(trace, 'utf8')).states.length;
    assert.equal(states, app.length + 1);
    const provenance = { schema: 'mirrorecma.application-witness/v1', generator: 'Apalache', version,
      arguments: flags, expectedExitCode: 12, purpose: 'TraceComplete deliberately requests the deterministic witness',
      modelSha256: await sha256(spec), traceSha256: await sha256(trace),
      contractSha256: await sha256(contract), compilerSha256: await sha256(compiler), states, transitions: states - 1 };
    await writeFile(join(artifacts, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    return trace;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, flag, output] = process.argv.slice(2);
  assert((flag === undefined && output === undefined) || (flag === '--output' && output),
    'Usage: node regenerate.mjs APPLICATION [--output DIR] (required for work-queue)');
  console.log(await generate(folder, output));
}
