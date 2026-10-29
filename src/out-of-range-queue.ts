// Out-of-range updates run one at a time, in the order they were confirmed,
// each after any bb update job for the same plugin ends (or gives up on it).
// The queue is in memory only: reloading this plugin (or bb) drops queued
// entries, and cuts off a running one wherever it was.
import type { ManualSteps, OutOfRangeEntry, OutOfRangeRequest, OutOfRangeResult } from "./contract";
import { message } from "./errors";
import type { OutOfRangeItem } from "./report";

type Outcome = NonNullable<OutOfRangeEntry["result"]>;

/** Finished entries stay listed this long, so other windows can catch up. */
const KEEP_DONE_MS = 10 * 60_000;

export function createOutOfRangeQueue({
  preflight,
  busy,
  pollMs,
  waitTimeoutMs,
  apply,
  afterEach,
  onChange,
}: {
  preflight: (id: string) => Promise<ManualSteps | { kind: "ready"; item: OutOfRangeItem }>;
  /** Whether something else is updating `id`; the entry waits, re-asking every `pollMs`. Must not throw. */
  busy: (id: string) => Promise<boolean>;
  pollMs: number;
  /** Past this, a waiting entry is done as `timed-out`, untouched. */
  waitTimeoutMs: number;
  /** Calls `onStart` with the version it re-read and moves from, which may differ from `item.from`. */
  apply: (item: OutOfRangeItem, onStart: (from: string) => void) => Promise<OutOfRangeResult>;
  /** Runs after every entry, whatever its outcome (re-check). Must not throw. */
  afterEach: () => Promise<unknown>;
  onChange: (entry: OutOfRangeEntry) => void;
}) {
  type Slot = {
    entry: OutOfRangeEntry;
    item: OutOfRangeItem;
    settled: Promise<Outcome>;
    resolve: (outcome: Outcome) => void;
    finishedAt?: number;
  };
  let slots: Slot[] = [];
  let lastRun = 0;
  let draining = false;

  const update = (slot: Slot, change: Partial<OutOfRangeEntry>) => {
    slot.entry = { ...slot.entry, ...change };
    onChange(slot.entry);
  };
  const pendingSlot = (id: string) =>
    slots.find((s) => s.entry.id === id && s.entry.state !== "done");
  const prune = () => {
    const cutoff = Date.now() - KEEP_DONE_MS;
    slots = slots.filter((s) => s.finishedAt === undefined || s.finishedAt > cutoff);
  };

  async function run(slot: Slot): Promise<Outcome> {
    const { id } = slot.entry;
    // Blocks the whole queue, which is fine: bb runs one install at a time anyway.
    if (await busy(id)) {
      update(slot, { state: "waiting" });
      const giveUpAt = Date.now() + waitTimeoutMs;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (!(await busy(id))) break;
        // Nothing's been removed yet, so giving up is safe; a stuck job can't hold the queue.
        if (Date.now() >= giveUpAt) return { kind: "timed-out" };
      }
    }
    update(slot, { state: "running" });
    try {
      return await apply(slot.item, (from) => {
        if (from !== slot.entry.from) update(slot, { from });
      });
    } catch (error) {
      return { kind: "error", error: message(error) };
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const next = slots.find((s) => s.entry.state === "queued");
        if (next === undefined) return;
        const result = await run(next);
        await afterEach();
        next.finishedAt = Date.now();
        update(next, { state: "done", result });
        next.resolve(result);
      }
    } finally {
      draining = false;
    }
  }

  /** Queues an update, or returns the one already queued or running for `id`. */
  async function enqueue(id: string): Promise<OutOfRangeRequest> {
    const pending = pendingSlot(id);
    if (pending !== undefined) return { kind: "entry", entry: pending.entry };
    const checked = await preflight(id);
    if (checked.kind === "manual") return checked;
    // Checked again: a second request may have queued it during the preflight.
    const raced = pendingSlot(id);
    if (raced !== undefined) return { kind: "entry", entry: raced.entry };
    const { item } = checked;
    let resolve!: (outcome: Outcome) => void;
    const settled = new Promise<Outcome>((r) => (resolve = r));
    const entry: OutOfRangeEntry = {
      run: ++lastRun,
      id,
      from: item.from,
      to: item.to,
      state: "queued",
    };
    prune();
    slots = [...slots.filter((s) => s.entry.id !== id), { entry, item, settled, resolve }];
    onChange(entry);
    void drain();
    return { kind: "entry", entry };
  }

  return {
    enqueue,
    list: (): OutOfRangeEntry[] => {
      prune();
      return slots.map((s) => s.entry);
    },
    /** The plugin's entry that isn't done yet, if any. */
    pending: (id: string) => pendingSlot(id)?.entry,
    /** Resolves with the run's outcome once it's done. */
    settled: (run: number) => {
      const slot = slots.find((s) => s.entry.run === run);
      if (slot === undefined) throw new Error(`No out-of-range update #${run}`);
      return slot.settled;
    },
  };
}
