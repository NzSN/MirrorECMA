import assert from 'node:assert/strict';
import { createAdapter } from './adapter.mjs';

/** Run submission-owned contract checks. */
export async function runBuild() {
  const adapter = await createAdapter();

  assert.deepEqual(Object.keys(adapter).sort(), ['actions', 'observe']);
  assert.deepEqual(Object.keys(adapter.actions).sort(), ['Initialize', 'Tick']);

  assert.equal(await adapter.actions.Initialize({}), undefined);
  assert.deepEqual(await adapter.observe(), { Count: 0n });

  assert.equal(await adapter.actions.Tick({ Stride: 7n }), undefined);
  assert.deepEqual(await adapter.observe(), { Count: 7n });

  await adapter.actions.Tick({ Stride: -12n });
  assert.deepEqual(await adapter.observe(), { Count: -5n });

  const large = (1n << 100n) + 123n;
  await adapter.actions.Tick({ Stride: large });
  assert.deepEqual(await adapter.observe(), { Count: large - 5n });

  await adapter.actions.Initialize({});
  assert.deepEqual(await adapter.observe(), { Count: 0n });

  const independent = await createAdapter();
  await independent.actions.Tick({ Stride: 3n });
  assert.deepEqual(await independent.observe(), { Count: 3n });
  assert.deepEqual(await adapter.observe(), { Count: 0n });
}
