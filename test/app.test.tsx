// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { DEFERRED_UPDATE, NEW_UPDATES, OUT_OF_RANGE_CHANGED, REPORT_CHANGED } from "../src/channels";
import type { DeferredUpdate, OutOfRangeEntry, ReportSnapshot, UpdateJob } from "../src/contract";

vi.mock("sonner", async (original) => ({
  ...(await original<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    loading: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

const snapshot = (badgeCount: number) =>
  ({ report: { badgeCount }, checkedAt: 1 }) as unknown as ReportSnapshot;

/** Renders the registered badge hook, as the host does, and exposes its value. */
async function renderBadge(report: () => ReportSnapshot | Promise<ReportSnapshot>) {
  const app = await loadPluginApp(() => import("../app"));
  const useBadge = app.navPanels[0]!.experimental_useBadge!;
  const slot = renderSlot(
    { component: () => <output>{JSON.stringify(useBadge())}</output> },
    {},
    { rpc: { report } },
  );
  const value = () => JSON.parse(slot.getByRole("status").textContent!);
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
  return { slot, value };
}

/** Lets pending RPC responses reach React, so a null value isn't just "not loaded yet". */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve)));

/** Every toast raised so far, oldest first, as [kind, message, options?]. */
function toasts() {
  const { error, loading, success, warning } = toast;
  return Object.entries({ plain: toast, error, loading, success, warning })
    .flatMap(([kind, fn]) => {
      const { calls, invocationCallOrder } = vi.mocked(fn as (...args: unknown[]) => unknown).mock;
      return calls.map((args, i) => ({ order: invocationCallOrder[i]!, call: [kind, ...args] }));
    })
    .sort((a, b) => a.order - b.order)
    .map(({ call }) => call);
}

async function renderOverlay(rpc: Record<string, () => unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const overlay = app.appOverlays[0]!;
  return renderSlot(overlay, { projectId: null, threadId: null } as never, { rpc });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("nav badge", () => {
  it("counts plugins with updates, leaving 9+ to bb", async () => {
    const { value } = await renderBadge(() => snapshot(12));
    await waitFor(() =>
      expect(value()).toEqual({ count: 12, label: "12 plugins have updates" }),
    );
  });

  it("uses a singular label for one plugin", async () => {
    const { value } = await renderBadge(() => snapshot(1));
    await waitFor(() =>
      expect(value()).toEqual({ count: 1, label: "1 plugin has an update" }),
    );
  });

  it("shows no badge at a count of 0", async () => {
    const { value } = await renderBadge(() => snapshot(0));
    await settle();
    expect(value()).toBeNull();
  });

  it("shows no badge before the first response, or before the first check", async () => {
    let respond!: (value: ReportSnapshot) => void;
    const { value } = await renderBadge(
      () => new Promise<ReportSnapshot>((resolve) => (respond = resolve)),
    );
    expect(value()).toBeNull();
    respond(null);
    await settle();
    expect(value()).toBeNull();
  });

  it("follows the report when the server says it changed", async () => {
    let count = 0;
    const { slot, value } = await renderBadge(() => snapshot(count));
    await waitFor(() => expect(value()).toBeNull());

    count = 3;
    await slot.behavior.emitRealtime(REPORT_CHANGED, { badgeCount: 3 });
    await waitFor(() =>
      expect(value()).toEqual({ count: 3, label: "3 plugins have updates" }),
    );

    count = 0;
    await slot.behavior.emitRealtime(REPORT_CHANGED, { badgeCount: 0 });
    await waitFor(() => expect(value()).toBeNull());
  });
});

describe("update toasts", () => {
  it("announces one plugin by name, with a View action", async () => {
    const slot = await renderOverlay();
    await slot.behavior.emitRealtime(NEW_UPDATES, {
      updates: [{ id: "homepage", version: "abc" }],
    });
    expect(toast).toHaveBeenCalledWith("Update available for homepage", {
      action: expect.objectContaining({ label: "View" }),
    });
  });

  it("announces several plugins by count, and stays quiet for none", async () => {
    const slot = await renderOverlay();
    await slot.behavior.emitRealtime(NEW_UPDATES, { updates: [] });
    expect(toast).not.toHaveBeenCalled();

    await slot.behavior.emitRealtime(NEW_UPDATES, {
      updates: [
        { id: "homepage", version: "abc" },
        { id: "agent-board", version: "def" },
      ],
    });
    expect(toast).toHaveBeenCalledWith("2 plugins have updates", expect.anything());
  });
});

describe("out-of-range toasts", () => {
  const TOAST_ID = "out-of-range-p";
  const COPY = { label: "Copy", onClick: expect.any(Function) };
  const RUNNING = ["loading", "Updating p to 2.0.0…", { id: TOAST_ID }];

  const entry = (
    state: OutOfRangeEntry["state"],
    fields: Partial<OutOfRangeEntry> = {},
  ): OutOfRangeEntry => ({ run: 1, id: "p", from: "1.0.0", to: "2.0.0", state, ...fields });

  const done = (result: OutOfRangeEntry["result"]) =>
    entry("done", result === undefined ? {} : { result });

  /** Renders the overlay over a queue the test moves, as the server's signal does. */
  async function renderQueue(initial: OutOfRangeEntry[]) {
    let entries = initial;
    const slot = await renderOverlay({ out_of_range_queue: () => ({ entries }) });
    await settle();
    return {
      slot,
      setEntries: (next: OutOfRangeEntry[]) => {
        entries = next;
      },
      moveTo: async (next: OutOfRangeEntry[]) => {
        entries = next;
        await slot.behavior.emitRealtime(OUT_OF_RANGE_CHANGED, { id: "p", state: "changed" });
        await settle();
      },
    };
  }

  /** The action on the latest toast. */
  const actionOf = () =>
    (toasts().at(-1)![2] as { action: { onClick: () => Promise<void> } }).action;

  it.each([
    ["queued", "Waiting to update p to 2.0.0…"],
    ["waiting", "Waiting for p's other update…"],
    ["running", "Updating p to 2.0.0…"],
  ] as const)("shows %s as a loading toast", async (state, message) => {
    await renderQueue([entry(state)]);
    expect(toasts()).toEqual([["loading", message, { id: TOAST_ID }]]);
  });

  it.each<[string, OutOfRangeEntry["result"], unknown[]]>([
    [
      "updated",
      { kind: "updated", from: "1.0.0", to: "2.0.0" },
      ["success", "Updated p to 2.0.0", { id: TOAST_ID }],
    ],
    [
      "rolled-back",
      { kind: "rolled-back", error: "Bad tarball." },
      ["error", "Couldn't update p; it's back on 1.0.0. Bad tarball.", { id: TOAST_ID }],
    ],
    [
      "failed",
      { kind: "failed", error: "Disk full.", command: "bb plugin install p" },
      [
        "error",
        "Updating p and the rollback both failed, so it isn't installed. Disk full. Reinstall with: bb plugin install p",
        { id: TOAST_ID, duration: Infinity, action: COPY },
      ],
    ],
    [
      "manual",
      { kind: "manual", reason: "self", command: "bb plugin update p" },
      [
        "warning",
        "p needs a manual update. Run: bb plugin update p",
        { id: TOAST_ID, duration: Infinity, action: COPY },
      ],
    ],
    [
      "timed-out",
      { kind: "timed-out" },
      [
        "error",
        "Gave up waiting for p's other update to finish; nothing was changed. Try again once it's done.",
        { id: TOAST_ID, duration: Infinity },
      ],
    ],
    [
      "error",
      { kind: "error", error: "Socket closed." },
      [
        "error",
        "Updating p failed partway; check whether it's installed. Socket closed.",
        { id: TOAST_ID, duration: Infinity },
      ],
    ],
    [
      "no result",
      undefined,
      [
        "error",
        expect.stringMatching(/^Updating p failed partway; check whether it's installed\.\s*$/),
        { id: TOAST_ID, duration: Infinity },
      ],
    ],
  ])("replaces the progress toast with the outcome: %s", async (_kind, result, outcome) => {
    const { moveTo } = await renderQueue([entry("running")]);
    await moveTo([done(result)]);
    expect(toasts()).toEqual([RUNNING, outcome]);
  });

  it.each<[string, OutOfRangeEntry["result"]]>([
    ["failed", { kind: "failed", error: "Disk full.", command: "bb plugin install p" }],
    ["manual", { kind: "manual", reason: "self", command: "bb plugin install p" }],
  ])("copies the command from a %s toast", async (_kind, result) => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { moveTo } = await renderQueue([entry("running")]);
    await moveTo([done(result)]);
    await actionOf().onClick();
    expect(writeText).toHaveBeenCalledWith("bb plugin install p");
  });

  it("moves one toast through every state of a run", async () => {
    const { moveTo } = await renderQueue([entry("queued")]);
    await moveTo([entry("waiting")]);
    await moveTo([entry("running")]);
    await moveTo([done({ kind: "updated", from: "1.0.0", to: "2.0.0" })]);
    expect(toasts()).toEqual([
      ["loading", "Waiting to update p to 2.0.0…", { id: TOAST_ID }],
      ["loading", "Waiting for p's other update…", { id: TOAST_ID }],
      RUNNING,
      ["success", "Updated p to 2.0.0", { id: TOAST_ID }],
    ]);
  });

  it("gives each plugin its own toast", async () => {
    await renderQueue([entry("running"), entry("queued", { run: 2, id: "q", to: "3.0.0" })]);
    expect(toasts()).toEqual([
      RUNNING,
      ["loading", "Waiting to update q to 3.0.0…", { id: "out-of-range-q" }],
    ]);
  });

  it("reuses the plugin's toast for its next run", async () => {
    const { moveTo } = await renderQueue([entry("running")]);
    await moveTo([done({ kind: "rolled-back", error: "Bad tarball." })]);
    await moveTo([entry("running", { run: 2 })]);
    expect(toasts().at(-1)).toEqual(RUNNING);
    expect(toasts()).toHaveLength(3);
  });

  it("stays quiet when a refetch finds the state unchanged", async () => {
    const { moveTo } = await renderQueue([entry("running")]);
    await moveTo([entry("running")]);
    expect(toasts()).toEqual([RUNNING]);
  });

  it("reports the version it re-read once running, without a new progress toast", async () => {
    const { moveTo } = await renderQueue([entry("running")]);
    await moveTo([entry("running", { from: "1.5.0" })]);
    expect(toasts()).toEqual([RUNNING]);
    await moveTo([entry("done", { from: "1.5.0", result: { kind: "rolled-back", error: "No." } })]);
    expect(toasts().at(-1)).toEqual([
      "error",
      "Couldn't update p; it's back on 1.5.0. No.",
      { id: TOAST_ID },
    ]);
  });

  it("doesn't announce runs already done on first load", async () => {
    const finished = done({ kind: "updated", from: "1.0.0", to: "2.0.0" });
    const { moveTo } = await renderQueue([finished]);
    await moveTo([finished]);
    expect(toasts()).toEqual([]);
    await moveTo([entry("running", { run: 2 })]);
    expect(toasts()).toEqual([RUNNING]);
  });

  it("ignores a slower answer from an older fetch", async () => {
    const answers: Array<(queue: { entries: OutOfRangeEntry[] }) => void> = [];
    const slot = await renderOverlay({
      out_of_range_queue: () => new Promise((resolve) => answers.push(resolve)),
    });
    const signal = async () => {
      await slot.behavior.emitRealtime(OUT_OF_RANGE_CHANGED, { id: "p", state: "changed" });
      await settle();
    };
    await settle();
    answers[0]!({ entries: [entry("running")] });
    await signal();
    await signal();
    answers[2]!({ entries: [done({ kind: "updated", from: "1.0.0", to: "2.0.0" })] });
    await settle();
    answers[1]!({ entries: [entry("running")] });
    await settle();
    expect(toasts()).toEqual([RUNNING, ["success", "Updated p to 2.0.0", { id: TOAST_ID }]]);
  });

  it("catches up on a missed outcome after reconnecting", async () => {
    const { slot, setEntries } = await renderQueue([entry("running")]);
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    setEntries([done({ kind: "updated", from: "1.0.0", to: "2.0.0" })]);
    await slot.behavior.setRealtimeConnectionState("connected");
    await settle();
    expect(toasts()).toEqual([RUNNING, ["success", "Updated p to 2.0.0", { id: TOAST_ID }]]);
  });
});

describe("deferred update toasts", () => {
  const job = (fields: Record<string, unknown>) =>
    ({ id: "job-1", pluginId: "p", displayName: "p", ...fields }) as unknown as UpdateJob;
  const JOB_TOAST = { id: "update-job-job-1" };

  const render = () => renderOverlay({ out_of_range_queue: () => ({ entries: [] }) });

  it.each<[string, DeferredUpdate, unknown[]]>([
    ["started", { id: "p", outcome: "started", jobId: "job-1" }, ["plain", "Started updating p"]],
    [
      "skipped",
      { id: "p", outcome: "skipped" },
      ["plain", "p has no compatible update left after its out-of-range update"],
    ],
    [
      "failed to start",
      { id: "p", outcome: "failed", error: "No network." },
      ["error", "Couldn't start updating p. No network."],
    ],
    [
      "ended, updated",
      {
        id: "p",
        outcome: "ended",
        job: job({ state: "completed", result: { outcome: "updated" } }),
      },
      ["success", "Updated p", JOB_TOAST],
    ],
    [
      "ended, rolled back with detail",
      {
        id: "p",
        outcome: "ended",
        job: job({ state: "completed", result: { outcome: "rolled-back", detail: "Bad hash." } }),
      },
      ["error", "p update rolled back. Bad hash.", JOB_TOAST],
    ],
    [
      "ended, rolled back without detail",
      {
        id: "p",
        outcome: "ended",
        job: job({ state: "completed", result: { outcome: "rolled-back" } }),
      },
      ["error", expect.stringMatching(/^p update rolled back\.\s*$/), JOB_TOAST],
    ],
    [
      "ended, job failed",
      { id: "p", outcome: "ended", job: job({ state: "failed", error: "Disk full." }) },
      ["error", "p: Disk full.", JOB_TOAST],
    ],
  ])("toasts %s", async (_name, update, expected) => {
    const slot = await render();
    await slot.behavior.emitRealtime(DEFERRED_UPDATE, update);
    expect(toasts()).toEqual([expected]);
  });

  it.each<[string, unknown]>([
    ["an empty payload", null],
    ["an empty object", {}],
    ["a payload with no outcome", { id: "p" }],
    ["an unknown outcome", { id: "p", outcome: "exploded" }],
    [
      "a job that hasn't ended",
      { id: "p", outcome: "ended", job: job({ state: "running", phase: "activating" }) },
    ],
  ])("stays quiet for %s", async (_name, payload) => {
    const slot = await render();
    await slot.behavior.emitRealtime(DEFERRED_UPDATE, payload);
    expect(toasts()).toEqual([]);
    // Still listening, so the silence above wasn't a missing subscription.
    await slot.behavior.emitRealtime(DEFERRED_UPDATE, {
      id: "p",
      outcome: "started",
      jobId: "job-1",
    });
    expect(toasts()).toEqual([["plain", "Started updating p"]]);
  });
});
