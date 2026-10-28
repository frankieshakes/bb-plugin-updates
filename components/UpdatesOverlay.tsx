import { useCallback } from "react";
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { DEFERRED_UPDATE, NEW_UPDATES } from "../src/channels";
import type { DeferredUpdate, OutOfRangeEntry } from "../src/contract";
import { useOutOfRangeQueue } from "@/hooks/useOutOfRangeQueue";
import { useRailBubble } from "@/hooks/useRailBubble";
import { useUpdates } from "@/hooks/useUpdates";
import { PANEL_PATH } from "@/lib/updates";

/** One toast per plugin, moved through queued → (waiting →) running → its outcome. */
function toastOutOfRange({ id, from, to, state, result }: OutOfRangeEntry) {
  const toastId = `out-of-range-${id}`;
  if (state === "queued")
    return toast.loading(`Waiting to update ${id} to ${to}…`, { id: toastId });
  if (state === "waiting")
    return toast.loading(`Waiting for ${id}'s other update…`, { id: toastId });
  if (state === "running") return toast.loading(`Updating ${id} to ${to}…`, { id: toastId });
  const sticky = (command: string) => ({
    id: toastId,
    duration: Infinity,
    action: {
      label: "Copy",
      onClick: () => navigator.clipboard.writeText(command).catch(() => undefined),
    },
  });
  switch (result?.kind) {
    case "updated":
      return toast.success(`Updated ${id} to ${to}`, { id: toastId });
    case "rolled-back":
      return toast.error(`Couldn't update ${id}; it's back on ${from}. ${result.error}`, {
        id: toastId,
      });
    case "failed":
      return toast.error(
        `Updating ${id} and the rollback both failed, so it isn't installed. ${result.error} Reinstall with: ${result.command}`,
        sticky(result.command),
      );
    case "manual":
      return toast.warning(
        `${id} needs a manual update. Run: ${result.command}`,
        sticky(result.command),
      );
    case "error":
    case undefined:
      return toast.error(
        `Updating ${id} failed partway; check whether it's installed. ${result?.error ?? ""}`,
        {
          id: toastId,
          duration: Infinity,
        },
      );
  }
}

/** A compatible update that waited for an out-of-range one; the page toasts its job's end. */
function toastDeferred(update: DeferredUpdate) {
  switch (update.outcome) {
    case "started":
      return toast(`Started updating ${update.id}`);
    case "skipped":
      return toast(`${update.id} has no compatible update left after its out-of-range update`);
    case "failed":
      return toast.error(`Couldn't start updating ${update.id}. ${update.error}`);
  }
}

/** Headless: owns the rail bubble and the toasts for every app window. */
export function UpdatesOverlay() {
  const { snapshot } = useUpdates();
  const navigate = useBbNavigate();
  const open = useCallback(() => navigate.toPluginPanel(PANEL_PATH), [navigate]);
  useRailBubble(snapshot?.report.badgeCount ?? 0);
  useOutOfRangeQueue(toastOutOfRange);
  useRealtime(DEFERRED_UPDATE, (payload) => {
    if (payload !== null) toastDeferred(payload as DeferredUpdate);
  });
  useRealtime(NEW_UPDATES, (payload) => {
    const updates = (payload as { updates?: Array<{ id: string }> } | null)?.updates ?? [];
    if (updates.length === 0) return;
    const names = [...new Set(updates.map(({ id }) => id))];
    toast(
      names.length === 1
        ? `Update available for ${names[0]}`
        : `${names.length} plugins have updates`,
      { action: { label: "View", onClick: open } },
    );
  });
  return null;
}
