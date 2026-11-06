import { useCallback } from "react";
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { NEW_UPDATES } from "../src/channels";
import { PANEL_PATH } from "@/lib/updates";

/** Headless: owns the new-update toasts for every app window. */
export function UpdatesOverlay() {
  const navigate = useBbNavigate();
  const open = useCallback(() => navigate.toPluginPanel(PANEL_PATH), [navigate]);
  useRealtime(NEW_UPDATES, (payload) => {
    const updates = (payload as { updates?: Array<{ id: string }> } | null)?.updates ?? [];
    if (updates.length === 0) return;
    const names = [...new Set(updates.map(({ id }) => id))];
    toast(
      names.length === 1 ? `Update available for ${names[0]}` : `${names.length} plugins have updates`,
      { action: { label: "View", onClick: open } },
    );
  });
  return null;
}
