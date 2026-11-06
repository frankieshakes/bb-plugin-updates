import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import { useUpdates } from "@/hooks/useUpdates";

/** The nav badge: how many plugins have updates. bb formats the count (`9+`, `99+`). */
export function useUpdatesBadge(): ExperimentalBadge | null {
  const { snapshot } = useUpdates();
  const count = snapshot?.report.badgeCount ?? 0;
  if (count === 0) return null;
  return { count, label: count === 1 ? "1 plugin has an update" : `${count} plugins have updates` };
}
