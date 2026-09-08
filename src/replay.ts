import type { StateComputer } from "./protocol.js";
import type { Transport } from "./transport.js";
import {
  receiveReplayMessage,
  replayCore,
  requireValidRegistration,
  synchronousReplayExecution,
} from "./replay-core.js";

export {
  decodeReplayMessage,
  receiveLine,
  receiveReplayMessage,
  requireValidRegistration,
} from "./replay-core.js";

/** Shared replay loop preserving legacy synchronous compute/encode ordering. */
export async function replayLoop(
  t: Transport,
  it: AsyncIterator<string>,
  compute: StateComputer,
): Promise<void> {
  await replayCore(t, it, synchronousReplayExecution(compute));
}

/** Run the historical registration barrier and replay lifecycle. */
export async function runLegacyReplay(
  t: Transport,
  compute: StateComputer,
): Promise<void> {
  const it = t[Symbol.asyncIterator]();
  let closed = false;
  const closeOnce = async () => {
    if (!closed) {
      closed = true;
      await t.close();
    }
  };
  try {
    requireValidRegistration(await receiveReplayMessage(it));
    await replayCore(t, it, synchronousReplayExecution(compute));
  } finally {
    await closeOnce();
  }
}
