import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from './regenerate.mjs';
import { loadApplication, runLocalAcceptance } from './suite.mjs';

const [folder, ...args] = process.argv.slice(2);
assert(['work-queue', 'persistent-transfer', 'lease-service'].includes(folder), 'unknown application');
let receiptPath, live = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--live' && !live) live = true;
  else if (args[i] === '--receipt' && !receiptPath && args[i + 1]) receiptPath = args[++i];
  else throw new Error('Usage: node run.mjs work-queue|persistent-transfer|lease-service [--live] [--receipt NEW_FILE]');
}
const app = await loadApplication(folder);
const scratch = await mkdtemp(join(tmpdir(), 'application-fresh-'));
try {
  const trace = live ? await generate(folder, join(scratch, folder)) : app.trace;
  const receipt = await runLocalAcceptance(app, live ? { tracePaths: [trace, trace] } : {});
  assert.equal(receipt.results.length, Object.keys(app.localFaults).length + 4);
  if (receiptPath) await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
