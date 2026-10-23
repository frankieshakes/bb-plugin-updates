import { useCallback } from "react";
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { useRailBubble } from "@/hooks/useRailBubble";
import { useUpdates } from "@/hooks/useUpdates";
import { PANEL_PATH } from "@/lib/updates";

/** Headless: owns the rail bubble and the toasts for every app window. */
export function UpdatesOverlay() {
  const { snapshot } = useUpdates();
  const navigate = useBbNavigate();
  const open = useCallback(() => navigate.toPluginPanel(PANEL_PATH), [navigate]);
  useRailBubble(snapshot?.report.badgeCount ?? 0);
  useRealtime("new-updates", (payload) => {
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
