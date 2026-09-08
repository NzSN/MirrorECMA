import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface QueueSnapshot {
  readonly pending: readonly bigint[];
  readonly inFlight: bigint;
  readonly completed: ReadonlySet<bigint>;
  readonly failed: boolean;
}

interface MutableQueue {
  pending: bigint[];
  inFlight: bigint;
  completed: Set<bigint>;
  failed: boolean;
}

function emptyQueue(): MutableQueue {
  return { pending: [], inFlight: 0n, completed: new Set(), failed: false };
}

/** A single-worker application store; it has no model or protocol dependencies. */
export class WorkQueue {
  private disposed = false;

  protected constructor(readonly directory: string) {}

  static async create(parentDirectory = tmpdir()): Promise<WorkQueue> {
    return new WorkQueue(await mkdtemp(join(parentDirectory, "mirrorecma-queue-")));
  }

  private active(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error("Work queue is disposed");
  }

  private async read(signal?: AbortSignal): Promise<MutableQueue> {
    this.active(signal);
    const text = await readFile(join(this.directory, "queue.json"), { encoding: "utf8", signal });
    this.active(signal);
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null || !("pending" in raw) ||
        !("inFlight" in raw) || !("completed" in raw) || !("failed" in raw) ||
        !Array.isArray(raw.pending) || !Array.isArray(raw.completed) ||
        typeof raw.inFlight !== "string" || typeof raw.failed !== "boolean" ||
        !raw.pending.every((item): item is string => typeof item === "string") ||
        !raw.completed.every((item): item is string => typeof item === "string")) {
      throw new Error("Invalid persisted queue state");
    }
    return {
      pending: raw.pending.map((item) => BigInt(item)),
      inFlight: BigInt(raw.inFlight),
      completed: new Set(raw.completed.map((item) => BigInt(item))),
      failed: raw.failed,
    };
  }

  private async write(state: MutableQueue, signal?: AbortSignal): Promise<void> {
    this.active(signal);
    const temporary = join(this.directory, "queue.next.json");
    await writeFile(temporary, JSON.stringify({
      pending: state.pending.map(String),
      inFlight: state.inFlight.toString(),
      completed: [...state.completed].map(String),
      failed: state.failed,
    }), { encoding: "utf8", signal });
    this.active(signal);
    await rename(temporary, join(this.directory, "queue.json"));
    this.active(signal);
  }

  private async update(change: (state: MutableQueue) => void, signal?: AbortSignal): Promise<void> {
    const state = await this.read(signal);
    change(state);
    await this.write(state, signal);
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.write(emptyQueue(), signal);
  }

  protected accepts(item: bigint, state: QueueSnapshot): boolean {
    return !state.pending.includes(item) && state.inFlight !== item && !state.completed.has(item);
  }

  async enqueue(item: bigint, signal?: AbortSignal): Promise<void> {
    if (item <= 0n) throw new RangeError("Job IDs must be positive; zero denotes no in-flight job");
    await this.update((state) => {
      if (this.accepts(item, state)) state.pending.push(item);
    }, signal);
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.update((state) => {
      if (state.inFlight !== 0n || state.pending.length === 0) {
        throw new Error("Start requires an idle worker and a pending job");
      }
      state.inFlight = state.pending.shift()!;
      state.failed = false;
    }, signal);
  }

  async fail(signal?: AbortSignal): Promise<void> {
    await this.update((state) => {
      if (state.inFlight === 0n || state.failed) throw new Error("Fail requires a running job");
      state.failed = true;
    }, signal);
  }

  async retry(signal?: AbortSignal): Promise<void> {
    await this.update((state) => {
      if (state.inFlight === 0n || !state.failed) throw new Error("Retry requires a failed job");
      state.failed = false;
    }, signal);
  }

  async complete(signal?: AbortSignal): Promise<void> {
    await this.update((state) => {
      if (state.inFlight === 0n || state.failed) throw new Error("Complete requires a running job");
      state.completed.add(state.inFlight);
      state.inFlight = 0n;
    }, signal);
  }

  async reset(signal?: AbortSignal): Promise<void> {
    await this.write(emptyQueue(), signal);
  }

  async observe(signal?: AbortSignal): Promise<QueueSnapshot> {
    // Always load the actual persisted data, never an expected state or cache.
    return this.read(signal);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.directory, { recursive: true, force: true });
  }
}

/** An application bug: repeated requests insert repeated pending jobs. */
export class BrokenWorkQueue extends WorkQueue {
  static override async create(parentDirectory = tmpdir()): Promise<BrokenWorkQueue> {
    return new BrokenWorkQueue(await mkdtemp(join(parentDirectory, "mirrorecma-queue-")));
  }

  protected override accepts(_item: bigint, _state: QueueSnapshot): boolean {
    return true;
  }
}
