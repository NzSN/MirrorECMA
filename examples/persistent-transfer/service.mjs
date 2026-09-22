import { mkdtemp, readFile, writeFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A resumable two-byte transfer with a persisted session journal and payload. */
export class PersistentTransfer {
  constructor(directory, fault = "correct") {
    this.directory = directory;
    this.fault = fault;
  }
  async load() {
    return JSON.parse(
      await readFile(join(this.directory, "journal.json"), "utf8"),
    );
  }
  async save(state) {
    await writeFile(
      join(this.directory, "journal.next"),
      JSON.stringify(state),
    );
    await rename(
      join(this.directory, "journal.next"),
      join(this.directory, "journal.json"),
    );
  }
  async initialize() {
    await writeFile(join(this.directory, "payload"), Buffer.alloc(0));
    await this.save({
      session: "0",
      phase: "idle",
      committed: false,
      accepted: false,
    });
  }
  async begin() {
    const state = await this.load();
    if (!["idle", "cancelled"].includes(state.phase))
      throw new Error("active transfer");
    await writeFile(join(this.directory, "payload"), Buffer.alloc(0));
    await this.save({
      session: String(BigInt(state.session) + 1n),
      phase: "open",
      committed: false,
      accepted: true,
    });
  }
  async chunk(token, offset, value) {
    const state = await this.load();
    const bytes = await readFile(join(this.directory, "payload"));
    const index = Number(offset);
    const tokenOK =
      this.fault === "stale-session" || String(token) === state.session;
    state.accepted =
      tokenOK &&
      state.phase === "open" &&
      index >= 0 &&
      (index === bytes.length ||
        (index < bytes.length && bytes[index] === Number(value)));
    if (
      state.accepted &&
      (index === bytes.length || this.fault === "duplicate-retry")
    ) {
      const byte =
        this.fault === "corrupt-content" ? Number(value) + 1 : Number(value);
      await writeFile(
        join(this.directory, "payload"),
        Buffer.concat([bytes, Buffer.from([byte])]),
      );
    }
    await this.save(state);
  }
  async pause() {
    const s = await this.load();
    s.phase = "paused";
    await this.save(s);
  }
  async resume() {
    const s = await this.load();
    s.phase = "open";
    await this.save(s);
  }
  async commit() {
    const s = await this.load();
    const bytes = await readFile(join(this.directory, "payload"));
    s.accepted =
      s.phase === "open" &&
      (bytes.length === 2 || this.fault === "premature-success");
    if (s.accepted) {
      s.committed = true;
      s.phase = "done";
    }
    await this.save(s);
  }
  async cancel() {
    const s = await this.load();
    await writeFile(join(this.directory, "payload"), Buffer.alloc(0));
    await this.save({
      ...s,
      phase: "cancelled",
      committed: false,
      accepted: true,
    });
  }
  async snapshot() {
    const s = await this.load();
    const bytes = await readFile(join(this.directory, "payload"));
    return {
      Session: BigInt(s.session),
      Phase: s.phase,
      Data: [...bytes].map(BigInt),
      Committed: s.committed,
      Accepted: s.accepted,
    };
  }
}

export async function createAdapter(fault = "correct", parent = tmpdir()) {
  const directory = await mkdtemp(join(parent, "transfer-"));
  let service = new PersistentTransfer(directory, fault);
  return {
    directory,
    actions: {
      Initialize: () => service.initialize(),
      Begin: () => service.begin(),
      Chunk: ({ Token, Offset, Value }) => service.chunk(Token, Offset, Value),
      Pause: () => service.pause(),
      Resume: () => service.resume(),
      // Drop the in-memory object; subsequent operations reload journal + bytes.
      Restart: () => {
        service = new PersistentTransfer(directory, fault);
      },
      Commit: () => service.commit(),
      Cancel: () => service.cancel(),
    },
    observe: () => service.snapshot(),
    trustedProbe: async () => ({
      journal: await service.load(),
      payload: [...(await readFile(join(directory, "payload")))],
    }),
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
