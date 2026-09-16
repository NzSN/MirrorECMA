// Imported by the deferred suite implementation factory, after model admission.
import {WorkQueue} from '../../dist-test/examples/work-queue/queue.js';
import {seededFaults} from '../../dist-test/examples/work-queue/acceptance.js';
import {nativeQueueAdapter} from '../../dist-test/examples/work-queue/native-adapter.js';

export async function createAdapter(variant = 'correct', parentDirectory) {
  const mutation = seededFaults.find(fault => fault.name === variant);
  if (variant !== 'correct' && !mutation) throw new Error('unknown implementation variant');
  const queue = await (mutation ? mutation.create(parentDirectory) : WorkQueue.create(parentDirectory));
  return nativeQueueAdapter(queue);
}
