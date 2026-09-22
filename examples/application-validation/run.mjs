import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generate } from './regenerate.mjs';
import { loadApplication, runLocalAcceptance } from './suite.mjs';
import { runtimeTreeIdentity } from '../../dist/project-config.js';
import { parseBoundedJsonValue } from '../../dist/reproduction-bundle.js';

const [folder, ...args] = process.argv.slice(2);
assert(['work-queue', 'persistent-transfer', 'lease-service', 'all'].includes(folder), 'unknown application');
let receiptPath, registryPath, live = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--live' && !live) live = true;
  else if (args[i] === '--receipt' && !receiptPath && args[i + 1]) receiptPath = args[++i];
  else if (args[i] === '--prevalidated-registry' && !registryPath && args[i + 1]) registryPath = args[++i];
  else throw new Error('Usage: node run.mjs work-queue|persistent-transfer|lease-service|all [--live] [--prevalidated-registry FILE] [--receipt NEW_FILE]');
}
assert(!(live && registryPath), 'fresh trace generation is separate from the prevalidated installed profile');
async function boundedJson(path, limit = 4 * 1024 * 1024) {
  const handle = await open(resolve(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    assert(before.isFile() && before.size <= BigInt(limit), 'registry must be a bounded regular file');
    const chunks = []; let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead; assert(total <= limit, 'registry exceeds byte limit'); chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && BigInt(total) === after.size, 'registry changed while reading');
    const bytes=Buffer.concat(chunks,total);
    return { value:parseBoundedJsonValue(bytes),sha256:createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}
let prevalidated;
let frameworkIdentity;
if (registryPath) {
  const absolute = resolve(registryPath), registryInput = await boundedJson(absolute), registry = registryInput.value;
  const frameworkPath=resolve(dirname(absolute),registry.frameworkInput);
  const frameworkInput=await boundedJson(frameworkPath);
  assert.deepEqual(registry.catalogSelectionRef,frameworkInput.value.selectionRef,'registry/framework catalog selection drift');
  assert.deepEqual(registry.installation,frameworkInput.value.installation,'registry/framework installation drift');
  const binding = registry.applicationValidation;
  assert(binding?.sourceArtifactId === 'application-validation-fixtures');
  const root = resolve(dirname(absolute), binding.root);
  assert.deepEqual(await runtimeTreeIdentity(root), binding.materializedTree, 'installed application closure drifted');
  const runtime = registry.installation?.runtimeTrees?.find(item => item.runtimeId === 'node-runtime');
  assert(runtime, 'installed Node runtime binding missing');
  const runtimeRoot = resolve(dirname(absolute), runtime.root);
  assert.deepEqual(await runtimeTreeIdentity(runtimeRoot), runtime.materializedTree, 'installed Node runtime drifted');
  const node = await realpath(process.execPath), admittedRoot = await realpath(runtimeRoot);
  assert(node.startsWith(`${admittedRoot}/`), 'aggregate is not running under the admitted Node tree');
  prevalidated = {
    status: 'verified',
    sourceArtifactId: binding.sourceArtifactId,
    sourceSha256: binding.sourceSha256,
    materializedTree: binding.materializedTree,
    catalogRaw: frameworkInput.value.catalogRaw,
    catalogSelectionRef: frameworkInput.value.selectionRef,
  };
  frameworkIdentity={catalogSelectionRef:frameworkInput.value.selectionRef,componentRefs:frameworkInput.value.observed.componentRefs,installedRegistrySha256:registryInput.sha256,frameworkInputSha256:frameworkInput.sha256,installationSchema:registry.installation.schema};
}
const scratch = await mkdtemp(join(tmpdir(), 'application-fresh-'));
try {
  const folders = folder === 'all' ? ['work-queue', 'persistent-transfer', 'lease-service'] : [folder];
  const receipts = [];
  for (const selected of folders) {
    const app = await loadApplication(selected);
    const trace = live ? await generate(selected, join(scratch, selected)) : app.trace;
    const receipt = await runLocalAcceptance(app, live ? { tracePaths: [trace, trace] } : prevalidated ? { prevalidated } : {});
    assert.equal(receipt.results.length, Object.keys(app.localFaults).length + 4);
    receipts.push(receipt);
  }
  const receipt = folder === 'all' ? {
    schema: 'mirrorecma.application-campaign-aggregate/v1',
    tier: prevalidated ? 'installed-prevalidated' : 'source',
    applications: receipts.map(item => item.application),
    denominator: receipts.reduce((sum, item) => sum + item.mutationCampaign.denominator, 0),
    acceptance: {
      status: receipts.every(item => item.mutationCampaign.status === 'complete' && item.mutationCampaign.acceptance.status === 'met') ? 'met' : 'unmet',
    },
    cleanup: {
      scope: 'local-cooperative',
      status: receipts.every(item => item.results.every(result => result.cleanup.status === 'confirmed')) ? 'confirmed' : 'failed',
      cases: receipts.reduce((sum, item) => sum + item.results.length, 0),
    },
    ...(frameworkIdentity ? { framework:frameworkIdentity } : {}),
    campaigns: receipts,
  } : receipts[0];
  if (folder === 'all') {
    assert.equal(receipt.denominator, 17);
    assert.equal(receipt.acceptance.status, 'met');
    assert.equal(receipt.cleanup.status, 'confirmed');
  }
  if (receiptPath) await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
