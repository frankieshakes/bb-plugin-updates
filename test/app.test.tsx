// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { NEW_UPDATES, REPORT_CHANGED } from "../src/channels";
import type { ReportSnapshot } from "../src/contract";

vi.mock("sonner", async (original) => ({
  ...(await original<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
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

afterEach(() => {
  cleanup();
  vi.mocked(toast).mockClear();
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
  async function renderOverlay() {
    const app = await loadPluginApp(() => import("../app"));
    const overlay = app.appOverlays[0]!;
    return renderSlot(overlay, { projectId: null, threadId: null } as never);
  }

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
