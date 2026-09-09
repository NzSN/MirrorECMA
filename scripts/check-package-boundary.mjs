import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mirror = process.env.MIRROR_BIN;
assert(mirror && existsSync(mirror), 'MIRROR_BIN is required for packed generic MBT acceptance');
const scratch = mkdtempSync(join(tmpdir(), 'mirrorecma-core-consumer-'));
const run = (command, args, cwd = scratch) => {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', env: {...process.env, NODE_PATH: ''}});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};
const copy = (relative, rewrite = false) => {
  const target = join(scratch, relative); mkdirSync(dirname(target), {recursive: true});
  if (rewrite) writeFileSync(target, readFileSync(join(root, relative), 'utf8').replaceAll('"../../src/index.js"', '"mirrorecma"'));
  else copyFileSync(join(root, relative), target);
};
try {
  // Installed package contents, not a source-tree import or a dependency symlink.
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch,
    '--cache', join(scratch, 'npm-cache')], root))[0];
  assert.equal(packed.version, '2.0.0');
  const target = join(scratch, 'node_modules/mirrorecma'); mkdirSync(target, {recursive: true});
  run('tar', ['-xzf', join(scratch, packed.filename), '--strip-components=1', '-C', target]);
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  for (const key of ['dependencies','optionalDependencies','peerDependencies','peerDependenciesMeta']) {
    assert(!Object.keys(pkg[key] ?? {}).some(name => name === 'mirrorgate' || name === 'mirrorgate-mirrorecma'), key);
  }
  const files = directory => readdirSync(directory, {withFileTypes: true}).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  for (const name of files(join(target, 'dist'))) {
    assert(!/sandbox|mirrorgate/i.test(relative(join(target, 'dist'), name)), `Removed module survived packing: ${name}`);
    if (!/\.(?:js|d\.ts)$/.test(name)) continue;
    const text = readFileSync(name, 'utf8');
    assert(!/SandboxGateEndpoint|SandboxSubmission|SandboxEvaluationPlan|TrustedGateLauncher/.test(text), name);
    assert(!/["']mirrorgate(?:-mirrorecma)?(?:["'/])/.test(text), name);
  }
  writeFileSync(join(scratch, 'package.json'), '{"private":true,"type":"module"}\n');
  copy('examples/mbt-counter/suite.ts', true);
  copy('examples/mbt-counter/local-provider.ts', true);
  copy('test/fixtures/model-interface/counter/generated-async/CounterMirror.generated.ts');
  writeFileSync(join(scratch, 'consumer.mts'), `
import assert from 'node:assert/strict';
import * as client from 'mirrorecma';
import type {AsyncAdapterFactory, CompiledReplayReport} from 'mirrorecma';
// Removed Gate-specific runtime and declaration exports must remain absent.
// @ts-expect-error MirrorECMA 2 core has no Gate evaluation facade
import type {SandboxEvaluationPlan} from 'mirrorecma';
import {runCounterSuite, counterReplayInputs} from './examples/mbt-counter/suite.js';
import {createLocalCounterFactory} from './examples/mbt-counter/local-provider.js';
for (const name of Object.keys(client)) assert(!/sandbox|mirrorgate|TrustedGate/i.test(name));
await assert.rejects(import('mirrorgate' as string), {code:'ERR_MODULE_NOT_FOUND'});
await assert.rejects(import('mirrorgate-mirrorecma' as string), {code:'ERR_MODULE_NOT_FOUND'});
const inputs=counterReplayInputs(${JSON.stringify(root)});
const context={...inputs, mirror:${JSON.stringify(resolve(mirror))}};
let creations=0, disposals=0;
const local=createLocalCounterFactory();
const factory: AsyncAdapterFactory=async(config, authority)=>{
  assert.equal(authority.status,'matched');creations++;
  const binding=await local(config,authority);
  return {...binding, dispose:async()=>{disposals++;await binding.dispose();}};
};
const report:CompiledReplayReport=await runCounterSuite(context,factory);
assert.equal(report.status,'completed');assert.equal(report.acceptedSteps,2);
assert.equal(creations,1);assert.equal(disposals,1);
await assert.rejects(runCounterSuite(context,createLocalCounterFactory(true)), {
  code:'replay_mismatch', action:'tick', traceIndex:0, stepIndex:1,
  expected:{count:{tag:'int',val:2n}}, actual:{count:{tag:'int',val:1n}},
});
const cancel=new AbortController();cancel.abort('packed pre-factory cancellation');
await assert.rejects(runCounterSuite({...context,signal:cancel.signal},factory),{code:'replay_cancelled'});
assert.equal(creations,1);assert.equal(disposals,1);
// Consumer has no Gate package; cancellation must still dispose a late binding.
const lateCancel=new AbortController();let lateDisposed=0;
await assert.rejects(runCounterSuite({...context,signal:lateCancel.signal},async(config,authority)=>{
  const binding=await local(config,authority);lateCancel.abort('packed factory cancellation');
  return {...binding,dispose:async()=>{lateDisposed++;await binding.dispose();}};
}),{code:'replay_cancelled'});
assert.equal(lateDisposed,1);
console.log('PACKED MIRRORECMA 2 CORE: declarations, local MBT, mismatch, report, cancellation and disposal GREEN');
`);
  run(join(root, 'node_modules/.bin/tsc'), ['consumer.mts', '--strict', '--target', 'ES2022', '--module', 'Node16',
    '--moduleResolution', 'Node16', '--types', 'node', '--typeRoots', join(root, 'node_modules/@types'), '--outDir', 'compiled']);
  console.log(run(process.execPath, [join(scratch, 'compiled/consumer.mjs')]));
} finally {
  rmSync(scratch, {recursive: true, force: true});
}
