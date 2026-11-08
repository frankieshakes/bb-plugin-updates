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

  it("announces a run first seen done after first load", async () => {
    const { moveTo } = await renderQueue([]);
    await moveTo([done({ kind: "rolled-back", error: "Bad tarball." })]);
    const outcome = [
      "error",
      "Couldn't update p; it's back on 1.0.0. Bad tarball.",
      { id: TOAST_ID },
    ];
    expect(toasts()).toEqual([outcome]);
    await moveTo([done({ kind: "rolled-back", error: "Bad tarball." })]);
    expect(toasts()).toEqual([outcome]);
  });

  it("announces only the new run when first load already had a done one", async () => {
    const finished = done({ kind: "updated", from: "1.0.0", to: "2.0.0" });
    const { moveTo } = await renderQueue([finished]);
    await moveTo([finished, entry("done", { run: 2 })]);
    expect(toasts()).toEqual([
      [
        "error",
        expect.stringMatching(/^Updating p failed partway/),
        { id: TOAST_ID, duration: Infinity },
      ],
    ]);
  });

  it("catches up on a run that started and ended while disconnected", async () => {
    const { slot, setEntries } = await renderQueue([]);
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    setEntries([done({ kind: "updated", from: "1.0.0", to: "2.0.0" })]);
    await slot.behavior.setRealtimeConnectionState("connected");
    await settle();
    expect(toasts()).toEqual([["success", "Updated p to 2.0.0", { id: TOAST_ID }]]);
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

describe("out-of-range toasts reusing one id", () => {
  // `sonner` merges a reused id's options into the toast already shown, so
  // replay what was raised into the real `sonner` and read back what it holds.
  // Its store outlives each test, so each test uses its own plugin.
  const real = vi.importActual<typeof import("sonner")>("sonner");
  let replayed = 0;
  afterEach(() => {
    replayed = 0;
  });
  async function shown(id: string) {
    const { toast: sonner } = await real;
    const raised = toasts() as [string, string, object][];
    for (const [kind, message, options] of raised.slice(replayed)) {
      (kind === "plain" ? sonner : sonner[kind as "error"])(message, options);
    }
    replayed = raised.length;
    return sonner.getToasts().find((t) => t.id === `out-of-range-${id}`) as
      { duration?: number; action?: { onClick: () => Promise<void> } } | undefined;
  }

  /** Renders the overlay over plugin `id`'s queue, which the test moves. */
  async function renderRuns(id: string) {
    const run = (run: number, fields: Partial<OutOfRangeEntry> = {}): OutOfRangeEntry => ({
      run,
      id,
      from: "1.0.0",
      to: "2.0.0",
      state: "running",
      ...fields,
    });
    let entries = [run(1)];
    const slot = await renderOverlay({
      out_of_range_queue: () => ({ entries }),
    });
    await settle();
    const moveTo = async (next: OutOfRangeEntry) => {
      entries = [next];
      await slot.behavior.emitRealtime(OUT_OF_RANGE_CHANGED, {
        id,
        state: "changed",
      });
      await settle();
    };
    return { run, moveTo };
  }

  const failed = (command: string) =>
    ({
      state: "done",
      result: { kind: "failed", error: "Disk full.", command },
    }) as const;

  it.each<[string, Partial<OutOfRangeEntry>]>([
    ["failed", failed("bb plugin install OLD")],
    [
      "manual",
      {
        state: "done",
        result: { kind: "manual", reason: "self", command: "OLD" },
      },
    ],
    ["timed-out", { state: "done", result: { kind: "timed-out" } }],
    ["error", { state: "done", result: { kind: "error", error: "Socket closed." } }],
  ])("lets a retry after %s auto-dismiss, with no stale action", async (kind, outcome) => {
    const id = `retry-${kind}`;
    const { run, moveTo } = await renderRuns(id);
    await moveTo(run(1, outcome));
    expect((await shown(id))?.duration).toBe(Infinity);
    for (const state of ["queued", "waiting", "running"] as const) {
      await moveTo(run(2, { state }));
      const toast = await shown(id);
      expect(toast?.duration).toBeUndefined();
      expect(toast?.action).toBeUndefined();
    }
    await moveTo(
      run(2, {
        state: "done",
        result: { kind: "updated", from: "1.0.0", to: "2.0.0" },
      }),
    );
    const toast = await shown(id);
    expect(toast?.duration).toBeUndefined();
    expect(toast?.action).toBeUndefined();
  });

  it("makes a sticky outcome after a retry sticky again, with its own action", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const id = "retry-sticky-again";
    const { run, moveTo } = await renderRuns(id);
    await moveTo(run(1, failed("bb plugin install OLD")));
    await moveTo(run(2));
    await moveTo(run(2, { state: "done", result: { kind: "timed-out" } }));
    let toast = await shown(id);
    expect(toast?.duration).toBe(Infinity);
    expect(toast?.action).toBeUndefined();
    await moveTo(run(3));
    await moveTo(run(3, failed("bb plugin install NEW")));
    toast = await shown(id);
    expect(toast?.duration).toBe(Infinity);
    await toast!.action!.onClick();
    expect(writeText).toHaveBeenCalledWith("bb plugin install NEW");
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

describe("updates page", () => {
  const HOUR = 60 * 60_000;
  const emptyReport = {
    compatible: [{ id: "homepage", from: "0.2.5", to: "0.2.7", version: "abc" }],
    outOfRange: [],
    blocked: [],
    ignored: [],
    upToDate: [],
    other: [],
    releaseCheckFailures: [],
    badgeCount: 1,
    newlySeen: [],
  };
  const SSL = "HTTP 422: git ls-remote failed (exit 128): SSL certificate problem";

  async function renderPage(rpc: Record<string, () => unknown>) {
    const app = await loadPluginApp(() => import("../app"));
    return renderSlot(app.navPanels[0]!, { subPath: "" } as never, {
      rpc: { jobs: () => ({ jobs: [] }), out_of_range_queue: () => ({ entries: [] }), ...rpc },
    });
  }

  it("shows that the last check failed, when, why, and that the counts are older", async () => {
    const now = Date.now();
    const page = await renderPage({
      report: () => ({
        report: emptyReport,
        checkedAt: now - 3 * HOUR,
        lastFailure: { at: now - 5 * 60_000, error: SSL },
      }),
    });

    const alert = await page.findByRole("alert");
    expect(alert.textContent).toContain("Last check failed 5m ago.");
    expect(alert.textContent).toContain(SSL);
    expect(alert.textContent).toContain("Showing results from the check 3h ago.");
    expect(page.getByText("Last checked 3h ago.")).toBeTruthy();
    expect(page.getByText("homepage")).toBeTruthy();
  });

  it("retries through Check now, and drops the failure once a check works", async () => {
    const now = Date.now();
    const check = vi.fn(() => ({ report: emptyReport, checkedAt: Date.now() }));
    const page = await renderPage({
      report: () => ({
        report: emptyReport,
        checkedAt: now - HOUR,
        lastFailure: { at: now, error: SSL },
      }),
      check,
    });

    const retry = await page.findByRole("button", { name: "Retry" });
    await act(async () => retry.click());

    await waitFor(() => expect(page.queryByRole("alert")).toBeNull());
    expect(check).toHaveBeenCalledTimes(1);
    expect(page.getByText("Last checked just now.")).toBeTruthy();
  });

  it("lists plugins bb couldn't check", async () => {
    const page = await renderPage({
      report: () => ({
        report: emptyReport,
        checkedAt: Date.now(),
        updateCheckFailures: [{ id: "agent-board", error: SSL }],
      }),
    });

    expect(await page.findByText("Couldn't check for updates")).toBeTruthy();
    expect(page.getByText("agent-board")).toBeTruthy();
    expect(page.queryByRole("alert")).toBeNull();
  });

  const nothing = { ...emptyReport, compatible: [], badgeCount: 0 };

  it("says every plugin is up to date only when every check worked", async () => {
    const page = await renderPage({ report: () => ({ report: nothing, checkedAt: Date.now() }) });

    expect(await page.findByText("Every plugin is up to date.")).toBeTruthy();
  });

  it.each([
    ["bb couldn't check one", { updateCheckFailures: [{ id: "agent-board", error: SSL }] }, "agent-board"],
    [
      "a release check failed",
      { report: { ...nothing, releaseCheckFailures: [{ id: "agent-board", error: SSL }] } },
      "agent-board",
    ],
  ])("doesn't say every plugin is up to date when %s", async (_, extra, id) => {
    const page = await renderPage({ report: () => ({ report: nothing, checkedAt: Date.now(), ...extra }) });

    expect(await page.findByText("No updates found, but 1 plugin couldn't be checked.")).toBeTruthy();
    expect(page.queryByText("Every plugin is up to date.")).toBeNull();
    expect(page.getByText(id)).toBeTruthy();
  });

  it("doesn't say every plugin is up to date when the last check failed", async () => {
    const page = await renderPage({
      report: () => ({ report: nothing, checkedAt: Date.now(), lastFailure: { at: Date.now(), error: SSL } }),
    });

    expect(await page.findByRole("alert")).toBeTruthy();
    expect(page.queryByText("Every plugin is up to date.")).toBeNull();
  });

  it("lists each plugin's failure in the notice when every check failed", async () => {
    const page = await renderPage({
      report: () => ({
        report: emptyReport,
        checkedAt: Date.now() - HOUR,
        lastFailure: {
          at: Date.now(),
          error: "every plugin's update check failed",
          failures: [
            { id: "agent-board", error: SSL },
            { id: "notes", error: "git ls-remote failed (exit 128): Operation timed out" },
          ],
        },
      }),
    });

    const alert = await page.findByRole("alert");
    expect(alert.textContent).toContain("every plugin's update check failed");
    expect(alert.textContent).toContain(`agent-board: ${SSL}`);
    expect(alert.textContent).toContain("notes: git ls-remote failed (exit 128): Operation timed out");
    expect(alert.textContent).not.toContain("notesgit");
    const items = Array.from(alert.querySelectorAll("li"), (li) => li.textContent);
    expect(items).toEqual([`agent-board: ${SSL}`, "notes: git ls-remote failed (exit 128): Operation timed out"]);
  });

  it("marks an update carried from an earlier check with when it was last confirmed", async () => {
    const page = await renderPage({
      report: () => ({
        report: {
          ...emptyReport,
          compatible: [{ ...emptyReport.compatible[0]!, stale: { confirmedAt: Date.now() - 3 * HOUR } }],
          outOfRange: [
            {
              id: "agent-board",
              from: "0.7.0",
              to: "0.9.2",
              version: "0.9.2",
              newSource: "git:x",
              compareUrl: "https://x",
              stale: { confirmedAt: Date.now() - 2 * HOUR },
            },
          ],
        },
        checkedAt: Date.now(),
        updateCheckFailures: [{ id: "homepage", error: SSL }],
      }),
    });

    expect(await page.findByText("Stale: last confirmed 3h ago")).toBeTruthy();
    expect(page.getByText("Stale: last confirmed 2h ago")).toBeTruthy();
  });

  it("shows no failure state after a good check", async () => {
    const page = await renderPage({
      report: () => ({ report: emptyReport, checkedAt: Date.now() }),
    });

    expect(await page.findByText("Last checked just now.")).toBeTruthy();
    expect(page.queryByRole("alert")).toBeNull();
    expect(page.queryByText("Couldn't check for updates")).toBeNull();
  });
});
