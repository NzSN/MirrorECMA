// Explicit publication from reviewed locks; does not generate traces or seal proposals.
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {root, run} from './regenerate.mjs';

const compiler = process.env.MODEL_INTERFACE_GEN ?? resolve(root, '../Mirrors/.lake/build/bin/model_interface_gen');
for (const folder of ['work-queue', 'persistent-transfer', 'lease-service']) {
  const directory = join(root, 'examples', folder);
  const app = JSON.parse(await readFile(join(directory, 'application.json'), 'utf8'));
  const artifacts = join(directory, 'artifacts');
  const lock = join(artifacts, `${app.module}.mirror-interface.lock.json`);
  const out = join(artifacts, 'bundle');
  run(compiler, ['bundle', '--lock', lock, '--target', 'mirrorecma-async-v1', '--out', out]);
  run(compiler, ['check-bundle', '--spec', join(directory, 'specs', `${app.module}.tla`),
    '--contract', join(artifacts, `${app.module}.mirror-interface.json`),
    '--evidence', join(artifacts, 'witness.itf.json'), '--param-var', 'parameters',
    '--lock', lock, '--target', 'mirrorecma-async-v1', '--out', out]);
}
console.log('Three reviewed application bundles generated and checked.');
