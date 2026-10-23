// Shared frontend constants and helpers.
export type { ReportSnapshot as Snapshot } from "../src/contract";
export { message as errorText } from "../src/errors";

export const PANEL_PATH = "updates";
export const PANEL_TITLE = "Plugin Updates";

export const relativeTime = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : new Date(at).toLocaleDateString();
};
