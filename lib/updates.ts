// Shared frontend constants and helpers.
import type { Report } from "../src/report";

export const PANEL_PATH = "updates";
export const PANEL_TITLE = "Plugin Updates";

/** The last check's report; null before the first check. */
export type Snapshot = { report: Report; checkedAt: number } | null;

export const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export const relativeTime = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : new Date(at).toLocaleDateString();
};
