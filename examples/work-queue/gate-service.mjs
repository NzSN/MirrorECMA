// Copied with queue.js plus the shared domain fault/observer fixture modules.
import { WorkQueue } from "./queue.js";
import { createQueueVariant } from "./validation-faults.mjs";
import { createQueueFixtureAdapter } from "./queue-fixture.mjs";

export async function createAdapter(variant = "correct") {
  return createQueueFixtureAdapter(
    await createQueueVariant(WorkQueue, variant),
  );
}
