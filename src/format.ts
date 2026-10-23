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
  const count = report.badgeCount;
  lines.push(
    `${count === 0 ? "No" : count} plugin${count === 1 ? "" : "s"} with updates. ` +
      `Checked ${new Date(checkedAt).toLocaleString()}.`,
  );
  return lines.join("\n");
}
