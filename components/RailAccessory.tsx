import { useUpdates } from "@/hooks/useUpdates";

/** For bb's native rail accessory slot, once a host surface renders it. */
export function RailAccessory() {
  const { snapshot } = useUpdates();
  const count = snapshot?.report.badgeCount ?? 0;
  return count === 0 ? null : <span className="text-xs tabular-nums">{count}</span>;
}
