// Imported by the deferred suite implementation factory, after model admission.
import { WorkQueue } from "../../dist-test/examples/work-queue/queue.js";
import { createQueueVariant } from "./validation-faults.mjs";
import { createQueueFixtureAdapter } from "./queue-fixture.mjs";

export async function createAdapter(variant = "correct", parentDirectory) {
  return createQueueFixtureAdapter(
    await createQueueVariant(WorkQueue, variant, parentDirectory),
  );
}
