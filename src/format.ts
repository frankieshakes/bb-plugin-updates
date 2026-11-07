// Plain-text rendering of a report for `bb plugin-updates`.
import type { Report } from "./report";

const name = (item: { id: string; disabled?: true }) =>
  item.disabled ? `${item.id} (disabled)` : item.id;

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [`${title}:`, ...lines.map((line) => `  ${line}`), ""];
}

export function formatReport(report: Report, checkedAt: number): string {
  const lines = [
    ...section(
      "Compatible updates",
      report.compatible.map((i) => `${name(i)}  ${i.from} → ${i.to}`),
    ),
    ...section(
      "Newer releases outside the installed range",
      report.outOfRange.map((i) => `${name(i)}  ${i.from} → ${i.to}  ${i.compareUrl}`),
    ),
    ...section(
      "Blocked by engine ranges",
      report.blocked.map((i) => `${i.id}  ${i.version}: ${i.reasons.join("; ")}`),
    ),
    ...section(
      "Ignored",
      report.ignored.map((i) => `${i.id}  ${i.to}`),
    ),
    ...section(
      "Couldn't check for newer releases",
      report.releaseCheckFailures.map((f) => `${f.id}  ${f.error}`),
    ),
  ];
  lines.push(`${summary(report)} Checked ${new Date(checkedAt).toLocaleString()}.`);
  return lines.join("\n");
}

const plugins = (n: number) => `${n} plugin${n === 1 ? "" : "s"}`;

// The badge count skips disabled plugins; say so rather than contradict the list.
function summary(report: Report): string {
  const count = report.badgeCount;
  const disabled = new Set(
    [...report.compatible, ...report.outOfRange].filter((i) => i.disabled).map((i) => i.id),
  ).size;
  if (disabled === 0) return `${count === 0 ? "No plugins" : plugins(count)} with updates.`;
  if (count === 0) {
    return `No enabled plugins with updates (${disabled === 1 ? "1 disabled plugin has an update" : `${disabled} disabled plugins have updates`}).`;
  }
  return `${plugins(count)} with updates, plus ${disabled} disabled.`;
}
