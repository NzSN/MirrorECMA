import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQueueSelection } from "../examples/work-queue/adapter.js";
import { WorkQueue } from "../examples/work-queue/queue.js";

test("the store preserves bigint IDs and observes persisted data without caching", async () => {
  const queue = await WorkQueue.create();
  try {
    const first = 9_007_199_254_740_993n;
    await queue.initialize();
    await queue.enqueue(first);
    await queue.enqueue(first + 1n);
    await queue.start();
    const before = await queue.observe();
    expect(before.inFlight).toBe(first);
    expect(before.pending).toEqual([first + 1n]);
    const path = join(queue.directory, "queue.json");
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.failed = true;
    await writeFile(path, JSON.stringify(stored));
    expect((await queue.observe()).failed).toBe(true);
  } finally { await queue.dispose(); }
});

test("aborted operations do not write and disposal prevents subsequent access", async () => {
  const queue = await WorkQueue.create();
  try {
    await queue.initialize();
    const before = await readFile(join(queue.directory, "queue.json"));
    const controller = new AbortController();
    controller.abort(new Error("cancel test"));
    await expect(queue.enqueue(1n, controller.signal)).rejects.toThrow("cancel test");
    expect(await readFile(join(queue.directory, "queue.json"))).toEqual(before);
    await queue.dispose();
    await expect(queue.observe()).rejects.toThrow("disposed");
  } finally { await queue.dispose(); }
});

test("constructing a negotiated selection allocates no application store", async () => {
  const parent = await mkdtemp(join(tmpdir(), "queue-deferred-test-"));
  let calls = 0;
  try {
    const selection = createQueueSelection(async () => {
      calls += 1;
      return WorkQueue.create(parent);
    });
    expect(selection.mode).toBe("dynamic");
    expect(calls).toBe(0);
    expect(await readdir(parent)).toEqual([]);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
